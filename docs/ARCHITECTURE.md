# Architecture

Multi-tenant organization task tracker: **Next.js 16 (App Router) + React 19 + TypeScript 6** on Vercel, **Neon PostgreSQL** via Drizzle ORM,
**Resend** for e-mail, **Better Auth** for authentication. Thai (default) and English.

```
Browser ── HTML/JS (nonce CSP, src/proxy.ts)
   │  fetch /api/** (cookie session, Origin check)
   ▼
Route handlers  src/app/api/**        validate (zod) → handle() → authenticate → rate-limit → tenant()
   │                                                                              │
   │                                              withTenant(userId, orgId)  ◄────┘
   ▼
Services        src/data/**           one transaction per request; s.require(permission, scope); audit; outbox event
   │
   ▼
PostgreSQL      row-level security (FORCE) + composite FKs + CHECKs        ◄── second, independent layer
   ▲
   │  withWorker / withWorkerOrg
Jobs            src/jobs/**           claimed with FOR UPDATE SKIP LOCKED + lease; woken by Vercel Cron → /api/cron/tick
   ├─ outbox.process → notifications → notification.email (Resend) · discord.send (Discord webhook)
   ├─ reminders.scan · digest.run · series.generate
   ├─ calendar.sync_task / resync / reconcile / cleanup (Google Calendar, one-way)
   └─ retention.purge (daily) · storage.orphans (weekly)
```

## Layers (what may import what)

| Directory | Responsibility |
|---|---|
| `src/domain/` | Pure rules, no I/O, fully unit-tested: workflow/transitions, dependency graph + cycle detection, recurrence, time zones/DST, notification policy, file sniffing, view filters, retention policy. |
| `src/authz/` | Permission catalog, system-role bundles, the pure evaluator (`can()`), generated matrix. |
| `src/data/` | Tenant-scoped services. **The only way to touch tenant tables from a request** is `withTenant()` → `TenantSession`. |
| `src/db/` | Drizzle schema, client (node-postgres locally / Neon WebSocket pool on `*.neon.tech`), RLS guard. |
| `src/integrations/` | Email (Resend, capture, file, log), Discord, Google Calendar, object storage (Vercel Blob, filesystem). Each behind a small interface so tests inject fakes. |
| `src/jobs/` | Queue, worker, handlers, scheduler. |
| `src/ops/` | Operator tools used by scripts and tests: attachment verification, key rotation. |
| `src/server/` | HTTP plumbing: `handle()`, auth setup, runtime wiring, rate limiter, request schemas. |
| `src/app/` + `src/ui/` | Pages and client components (client-side fetch with a small `useQuery` hook; open pages watch a cheap change signal, see below). |
| `scripts/` | Operator CLIs: migrate, bootstrap, backup, restore drill, verify-*, smoke, rotate, generators. |

## Request lifecycle

1. `src/proxy.ts` adds a CSP nonce to HTML requests. `next.config.ts` adds the static security headers.
2. A route handler wraps its work in `handle(req, fn, {limit?})`: same-origin check for mutating methods → session lookup (401) → optional per-user rate limit (429) →
   `x-request-id` on every response → uniform error mapping (`AppError` → JSON with a stable `code`; unexpected → 500 and a redacted log line).
3. `c.tenant(orgId, fn)` opens **one transaction**: sets `app.user_id`, checks an *approved* membership (else 404), sets `app.org_id`, loads the principal’s role assignments, runs `fn`.
4. Services call `s.require("task.update", scope)` with a scope resolved from the database. Denials are audited in a separate transaction (so the audit row survives the rollback).
5. Services write domain rows, `task_activity`, `audit_logs` and an `outbox_events` row **in the same transaction**; nothing external happens in the request.

## Decisions and why

| Decision | Reason | Alternative not chosen |
|---|---|---|
| Postgres RLS **plus** application scoping | A bug in either layer alone must not leak a tenant. The runtime role is verified not to bypass RLS. | App-only filtering. |
| Jobs in Postgres (`jobs`, `outbox_events`), Vercel Cron only as the alarm clock | Retries, leases, dead-lettering and idempotency live in the database, so missed/duplicate cron calls are harmless and no extra provider is needed. | Inngest/QStash/Vercel Workflow (more moving parts, pricing/limits unverified). |
| Notifications store *type + ids*, rendered on read | Access is re-checked at read time; no copy of protected text sits in the notifications table. | Pre-rendered text. |
| Change signals instead of push | Open pages poll `GET /api/orgs/:id/changes` every ≈ 8 s (visible tabs only, shared between components, exponential back-off) which returns a few opaque hashes of what the caller may read; a page re-runs its real query only when its hash moved (plus on focus and a 5-minute safety net). Works on serverless without long-lived connections; permission-aware by construction (hashes cover only readable projects, the caller's own notifications, and comments of a readable task). Changes appear within roughly 10–20 s. **This is still polling, not push.** | SSE/WebSocket or a hosted channel (Ably/Pusher) for sub-second updates; a per-project change counter (rejected: a hot row every writer must lock). |
| One-way calendar sync with deterministic event ids | No duplicates on retry; no reading from Google means no inbound trust boundary. | Two-way sync. |
| Soft delete → 30-day trash → purge job | Undo for humans, bounded retention for the business; see [RETENTION.md](RETENTION.md). | Immediate hard delete. |
| Recurring tasks as ordinary tasks linked to a series (unique `(series_id, occurrence_date)`) | All views, permissions and reminders work unchanged; edits apply only to open future occurrences. | Virtual occurrences. |
| Safe, tree-based Markdown for comments/descriptions | Formatting without an HTML string anywhere: parser → typed tree → React elements; no HTML passthrough, http(s) links only, no images. | A Markdown library + sanitizer (a larger attack surface to keep patched). |

## Data model

See [ERD.md](ERD.md) (generated from the migrated database): 42 tables, 74 foreign keys. Highlights: `organizations → memberships → role_assignments(scope)`,
`departments → teams ↔ projects (project_teams)`, `tasks` (self-referencing parent, `task_dependencies`, `task_assignees`, `comments`, `attachments`, `task_activity`),
`notifications`/`outbox_events`/`jobs`, `integration_destinations`, `calendar_connections → calendar_event_links`, `recurrence_series`, `custom_field_defs → custom_field_values`, `saved_views`, `audit_logs`.

## Scheduling (`src/jobs/tick.ts`)

| Job | Bucket | Purpose |
|---|---|---|
| `outbox.process` | 60 s | Turn committed domain events into notifications and downstream jobs. |
| `reminders.scan` | 5 min | Due-soon and overdue reminders at 09:00 in the assignee’s own zone. |
| `digest.run` | 1 h | Daily/weekly digests respecting each user’s zone and quiet hours. |
| `series.generate` | 1 h | Top up recurring-task occurrences (30-day horizon, never backfilling the past). |
| `calendar.reconcile` | 24 h | Detect drift between tasks and calendar links. |
| `retention.purge` | 24 h | See [RETENTION.md](RETENTION.md). |
| `storage.orphans` | 7 d | Remove unreferenced files. |

A job’s dedupe key includes its time bucket, so overlapping ticks enqueue it once. Handlers are idempotent and re-check permissions before touching protected content.
Back-off: 30 s doubling to 1 h with jitter; `maxAttempts` then *dead*; a handler may `Deferred` (no attempt consumed) or `PermanentFailure`.

## Observability

Structured JSON logs (pino) with key-based redaction; `x-request-id` on API responses; `GET /api/health` (liveness) and `GET /api/health/ready` (database, RLS role, schema version, job health; bearer-protected);
the cron route logs `job queue needs attention` when jobs are dead/stuck/old; Settings → Job health for administrators. Unexpected errors (API routes, failed renders via `instrumentation.ts`) go through one redacting path (`src/lib/error-report.ts`): a log line always, and a Sentry-protocol event when `SENTRY_DSN` is set. Browser-side failures show `app/error.tsx` / `global-error.tsx` with a reference code that matches the server log. There is no APM (see limitations).

## Time and language

Dates are calendar dates (`YYYY-MM-DD`) and never shift with DST; reminders and digests compute instants from a date plus the recipient’s IANA zone (offset-bracketed, tested across DST transitions).
Thai uses the Buddhist Era (`th-TH`); locale is a cookie (`tt_locale`) for signed-out pages and a profile field once signed in. Status/priority values are stable identifiers, translated only for display.
