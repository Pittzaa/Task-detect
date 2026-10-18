# Known limitations, deviations from the brief, and unresolved decisions

Honest list. “Deviation” = the brief asked for something this release does not do. “Risk” = works, but you should know. “Unverified” = built, but never exercised against the real service.

## Deviations from the brief

| # | Brief | What was built | Why / how to close it |
|---|---|---|---|
| 1 | Attachments up to **25 MB** | **4 MB** through the server, **25 MB** through a direct browser → Blob upload (built, **untested against a real Blob store**), 25 files per task | The direct path is verified up to the edge of the Blob service: the token endpoint (session, permission, rate limit, name/size/type constraints, decoded and asserted) and the server-side inspection of the stored object are tested with real code; the browser → Vercel Blob request itself, the CSP entry `connect-src https://vercel.com/api/blob/` (taken from the SDK source) and private-store support for client tokens are **unverified** until you run the checklist in [DEPLOYMENT.md](DEPLOYMENT.md) §8. Without a Blob token (development) only the 4 MB path exists. |
| 2 | Markdown in comments/descriptions | **A safe subset**: bold/italic/strike, code and fenced code, quotes, lists, rules, http(s) links. No HTML, tables, images, task-list checkboxes or reference links | Hand-written renderer (no HTML is ever produced). Existing plain-text comments render the same unless they contain Markdown characters (`*x*`, `# `, `- `, a bare `https://…` becomes a link). Descriptions and comments are still *stored* as typed. |
| 3 | Real-time updates | **Change-signal polling**: an open page asks a cheap endpoint every ≈ 8 s whether anything it can see changed, and re-fetches only then (changes appear in ≈ 10–20 s; previously up to 60 s); refetch on focus; 5-minute safety-net refresh | Serverless friendly and permission-aware. **Not push**: no sub-second updates, and each open tab costs one small request per ≈ 8 s while visible (hidden tabs send nothing). Changes to members, structure, settings and attachments are not covered by the signal and show up on focus/safety-net refresh. An SSE/WebSocket channel was not built. |
| 4 | Push notifications | Not implemented | Explicitly out of scope until later. |
| 5 | “superadmin” | A **flag only**; grants nothing in any organization | No cross-tenant operator console exists; operators use the scripts and the database. |
| 6 | Team/project “membership” tables | Modelled as **scoped role assignments** | One mechanism instead of three; semantics are in [RBAC.md](RBAC.md). A person “belongs to” a team by holding an assignment scoped to it. |
| 7 | Drag-and-drop everywhere | Board drag-and-drop plus a status `select` on every card/row | Keyboard/touch parity. No drag-to-reschedule on the calendar/timeline. |
| 8 | Daily automated database backups | A **verified procedure and script**, but no scheduler in the repository | Neon’s own backup features are plan-dependent and unverified; a scheduled job must be created by you ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)). |
| 9 | Backups of object storage | **Not provided** | See [BACKUP_RESTORE.md](BACKUP_RESTORE.md) §2.3. |

## Unverified against real services (never run)

Vercel (hosting, Cron, Blob), Neon (pooler behaviour, owner attributes, backup/PITR), Resend (delivery, domain verification, rate limits), Google (OAuth consent, Calendar API quotas), Discord (webhook rate limits). Fakes prove our handling of the documented shapes only.
Use `pnpm verify:database`, `pnpm smoke`, `pnpm verify:attachments` and the manual checklist in [DEPLOYMENT.md](DEPLOYMENT.md) §8.

## Risks and gaps

* **Single browser engine tested** (Chromium; desktop and 375 px). No Firefox/WebKit, no real devices, no screen-reader session. Automated accessibility checks (axe, WCAG 2.0/2.1 A/AA) pass on every page and dialog in light and dark themes, but they detect only part of the possible issues.
* **No load or performance testing.** Indexes exist for the main queries; list queries are paginated (50) and capped (100–500); but nothing was measured at volume. `listPeople` loads each candidate’s principal individually (≈ N queries for N members, capped at 500).
* **Error tracking is optional and only tested against a fake.** With `SENTRY_DSN` set, unexpected server errors are posted as redacted Sentry-protocol envelopes (hand-written, no SDK, https only, 3 s timeout, deduplicated, ≤ 20/min); browser errors are not collected. **No request has ever reached a real Sentry/GlitchTip**, so check in your tracker that an event arrives (`DEPLOYMENT.md` §8). No performance monitoring (APM) is integrated. Logs are structured JSON; alert on them yourself. No dead-man’s-switch if cron stops entirely (an external monitor on `/api/health/ready` covers it only if you set one up).
* **E-mail:** no bounce/complaint processing, no unsubscribe link (all mail is transactional or opt-in digests), plain-text/HTML templates are minimal.
* **Account erasure and data export exist** ([RETENTION.md](RETENTION.md#account-erasure)) and are tested against a real database, but **not legally reviewed**: whether keeping authored work attributed to “Deleted user” satisfies PDPA/GDPR for your organization is a decision for your data-protection officer. Erasure is not re-applied to backups; the placeholder name is stored in one language (Thai + English).
* **Per-organization export/import exists** (`pnpm org`, [BACKUP_RESTORE.md §6](BACKUP_RESTORE.md#6-one-organization-export-import-and-partial-restore)) and is tested between two real PostgreSQL databases, but it has **never run against Neon** (it needs an operator role with `BYPASSRLS`, which you must create), it does not move attachment files, and it loads the bundle in memory.
* **Retention:** a trashed task whose calendar event could not be removed stays in the trash (logged as `skippedWithCalendarLinks`) until the event is cleaned up. The orphan sweep lists a whole organization’s prefix in one go — fine for thousands of files, slow for millions.
* **Rate limits** are per user/key in the database (fixed window). There is no per-IP limit at the edge; put Vercel Firewall / Cloudflare rules in front of `/api/auth/*`.
* **Attachment content:** type is sniffed from bytes, but there is no malware scan and no preview/thumbnail generation.
* **Dependency advisory (accepted):** `braces` ≤ 3.0.3 via ESLint tooling, dev-only, no patched version published ([SECURITY.md](SECURITY.md) §3).
* **Concurrent role edits** are guarded by advisory locks for the last-administrator rule, but two administrators editing the same person’s roles at once get last-write-wins semantics on separate assignments.
* **No “change password” screen for signed-in users** (only the e-mailed reset flow, which does sign out all other sessions). Users can change their password by requesting a reset.
* **Lists** are paged with `offset` capped at 10 000 rows; beyond that use filters. **Notification and permission checkboxes** wait for the server before changing state (no optimistic update), which feels slow on bad connections.
* **Search** is substring/trigram, not linguistic: Thai word segmentation is not applied, so partial-word matches work but ranking is basic.
* **Calendar sync** is one-way and per user; shared/team calendars, attendee invitations and time-of-day events are not supported (all-day events from dates).
* **Time zones:** a user’s zone is set from the browser at registration; there is no automatic travel detection.
* `GET /api/cron/tick` runs the worker inside one function invocation (≤ 45 s). Very large backlogs drain over several ticks.

## Decisions left to the owner

1. Vercel plan: per-minute cron (Pro) vs. an external scheduler ([DEPLOYMENT.md](DEPLOYMENT.md) §0).
2. How and where to run the daily backup and the monthly restore drill, and whether to back up Blob.
3. Whether to keep direct-to-Blob uploads switched on after you have tried them on the real store (`DIRECT_UPLOADS=off` turns them off without a redeploy of code).
4. A security contact address and an incident owner.
5. Whether real-time push of changes (beyond the faster polling now built) and SSO/SCIM are wanted in the next release.
6. Retention periods (30-day trash, 90-day notifications) — adjust `src/domain/retention.ts` if your policy differs.
