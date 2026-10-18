# Readiness report

Date of the final test pass: 2026-10-17/18 (sandbox clock). Scope: the whole application, Phases 0–5, plus a final security-and-bug pass.
This report separates what was **verified** (command and result given), what was **partially** verified, and what **could not be verified** here. Nothing below is claimed beyond that.

## 1. Verdict

* **As software, locally:** the application builds, passes every automated check that exists (503 unit/integration tests, 78 browser tests, static analysis, dependency audit for shipped code, a restore drill, database and smoke verifications), and the final passes found and fixed the defects listed in §5.
* **As a service you can launch today: no.** It has **never run on Vercel, Neon, Resend, Google, Discord or Vercel Blob**, and no restore has been tested on a real Neon plan. Those are explicit **go-live blockers** (§4). Everything else is in good shape to hand over, with the limitations listed in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## 2. Commands run and their results

All against PostgreSQL 16.15 on a local cluster, Node 22.22, pnpm 10.28, Chromium (Playwright 1.64). Results are from the final state of the branch `claude/phase0-proposal`.

| Command | Result |
|---|---|
| `pnpm lint` | clean (no errors, no warnings) |
| `pnpm typecheck` | clean |
| `pnpm test:unit` | **163 / 163 passed** (15 files) |
| `TEST_DATABASE_URL=… pnpm test:integration` | **340 / 340 passed** (23 files) |
| `pnpm build` | compiled successfully (all pages, 61 API routes, proxy) |
| `pnpm exec playwright test tests/e2e` (fresh database) | **78 / 78 passed** (10 spec files, ≈ 3 min) |
| `pnpm audit --prod` | **No known vulnerabilities** |
| `pnpm audit` (incl. dev tools) | 1 high: `braces` ≤ 3.0.3 via ESLint tooling, dev-only, no patched version listed — **accepted**, see [SECURITY.md](SECURITY.md) §3 |
| `pnpm backup:restore-test` | **20 / 20**: dump 177 631 bytes → restore → 9 structure comparisons identical, **43 tables / 516 rows with identical content checksums**, each tenant sees only its own rows through the restored least-privilege role, audit log still append-only |
| `pnpm verify:database` (runtime role, E2E database) | **13 / 13** (also correctly *fails* for a superuser connection) |
| `pnpm smoke` (local production server) | **17 / 17** |
| `scripts/backup.sh` with encryption | dump → AES-256 → checksum → decrypt → `pg_restore --list` verified; wrong passphrase rejected; refuses a role without `BYPASSRLS` (exit 3) |
| Mutation checks (see [TESTING.md](TESTING.md)) | 6 deliberate breakages, each caught by a test |

Test inventory: 163 unit + 340 integration + 78 end-to-end = **581 automated tests**. Source ≈ 11 400 lines, tests ≈ 7 900 lines. 14 commits on the branch.

## 3. Acceptance checklist (brief §20)

Legend: ✅ verified here · ⚠️ verified only against fakes / locally, real service unverified · ❌ not verified

| Requirement | Status | Evidence / caveat |
|---|---|---|
| Tenant isolation and server-side RBAC | ✅ locally, ⚠️ Neon | RLS + app scoping; 19 isolation tests, route sweep (all routes × all methods as another tenant: no 2xx, no 5xx, no leakage), browser tests. **Neon pooler behaviour and the default owner’s attributes unverified** — `pnpm verify:database` proves them on the real service. |
| Authentication and account approval | ✅ locally, ⚠️ e-mail | Registration, verification, approval, invitations, reset (revokes other sessions), 2FA with backup codes, session revocation, secure cookies. Real e-mail delivery (Resend) unverified. |
| Task workflow, assignments, subtasks, dependencies | ✅ | Unit + 42 integration + browser tests; races covered. |
| Search, views, bulk-action authorization | ✅ | Per-record authorization, partial/atomic bulk, stable paging, wildcard-safe search incl. Thai. |
| Notifications without unauthorized disclosure | ✅ | Ids stored, text rendered after a fresh access check; mention → tick → bell + mail in the browser. |
| E-mail, Discord and Google Calendar behaviour | ⚠️ | Logic, idempotency, retries, duplicate prevention, one-way sync, revoked credentials and SSRF validation tested **with fakes**. **No live request ever reached Resend, Discord or Google.** Mock tests are not evidence that the live services accept the requests. |
| Recurring tasks, time zones, Thai/English | ✅ (Chromium) | DST tests east/west of UTC, Buddhist Era, profile zone, language persisted, UI in both languages. |
| Secure attachment access | ✅ filesystem store, ⚠️ Blob | Content sniffing, private download route, headers, byte-exact round trip, cap race fixed. Vercel Blob client type-checked only; 4 MB limit (brief asked 25 MB). |
| Audit retention and deletion behaviour | ✅ | 90-day floor enforced **in the database**; 30-day trash; purge job tested end to end; append-only proven for the runtime role. |
| Backup and a successful restore test | ⚠️ | **Local drill passed (above).** Neon’s own backups / point-in-time restore: unverified. Blob content: **no backup mechanism exists**. A scheduled backup job is not in the repository. |
| Test suite, type check, lint, production build, deployment configuration | ✅ locally, ⚠️ deployment | `vercel.json` (cron every minute) never deployed; plan limits unverified. |
| Operational documentation and known limitations | ✅ | 16 documents; derived parts (permission matrix, ERD) are generated and guarded by tests. |

## 4. Go-live blockers (clear all before real users)

1. **Deploy to a real Vercel project with a real Neon database**, run `pnpm verify:database`, `pnpm smoke`, and the manual checklist in [DEPLOYMENT.md](DEPLOYMENT.md) §8. Until then the integrations are untested in the only environment that matters.
2. **Confirm the Vercel plan can run the cron every minute** (or choose an external scheduler); otherwise notifications and reminders are late (jobs are durable, so nothing is lost).
3. **Backups on your actual Neon plan:** record the restore window, create a **dedicated `BYPASSRLS` backup role** (a plain owner cannot `pg_dump` this schema), schedule `scripts/backup.sh` somewhere that has `pg_dump`, and **perform a restore into a scratch database** ([BACKUP_RESTORE.md](BACKUP_RESTORE.md) §5). Decide what to do about Blob content, which nothing backs up.
4. **Verify Resend end to end** (domain verified, a real message delivered), and Google/Discord if you intend to use them.
5. **Secrets hygiene:** `APP_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` stored outside Vercel as well; preview deployments isolated from production data.
6. **Name a security contact and an incident owner** (none is configured).
7. **Monitoring:** an uptime check on `/api/health/ready` and log alerting; no APM is integrated.

## 5. Defects found and fixed in the final passes

Security: owner-bound RLS gaps (bootstrap / system-role sync / audit retention failing for a plain owner), `pg_dump` impossible for such an owner (now pre-checked), RLS role never enforced at runtime (now a production guard), missing CSP and security headers, no request ids, readiness blind to migrations, **HTTP 500 on NUL characters** (every route), calendar-connect answering before the membership check, irreversible actions without confirmation.
Correctness: UI “today” in the wrong time zone, MFA backup codes unusable at sign-in, **attachment cap exceeded under concurrency**, **bulk-update deadlock**, refused custom-field value discarded from the form, stale member list.
Accessibility / layout: label-in-name on icon buttons, calendar grid roles, keyboard-unreachable scroll regions, off-screen menu in the tab order, mobile horizontal overflow from absolutely-positioned text.
Details and evidence: [SECURITY.md](SECURITY.md) §4, [TESTING.md](TESTING.md).

## 6. What was added in Phase 5

* **Retention:** daily purge job (trash, deleted attachments/comments/destinations, operational rows, expired auth artefacts), weekly orphan sweep, 90-day audit floor in the database — [RETENTION.md](RETENTION.md).
* **Operations:** backup script and restore drill, attachment verifier, key-rotation tool, database and HTTP deployment checks, health/readiness endpoints, request ids, route-level rate limits, RLS runtime guard.
* **Security hardening:** nonce-based CSP, security headers, NUL-byte rejection, production cookie verification.
* **Product gaps closed:** recurring-tasks screen, backup-code sign-in, confirmations, accessibility fixes.
* **Documentation:** the full set required by the brief, with generated parts guarded by tests.
* **Migrations:** `0010` indexes, `0011` retention controls, `0012` owner bootstrap policies (13 in total).

## 7. Known limitations and decisions

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md): 4 MB attachments, plain-text comments, polling instead of push, no account-erasure/export tool, no per-tenant restore, single-browser testing, no load testing, no APM, and the decisions left to the owner.

## 8. Repository state

Branch `claude/phase0-proposal` is pushed to `origin` (Pittzaa/Task-detect). **No pull request exists**: the repository has no `main` branch to target and an earlier attempt to create one was blocked, so a base branch must be created (or chosen) by the owner before a PR can be opened.
