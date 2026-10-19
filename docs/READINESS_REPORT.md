# Readiness report

Date of the final test pass: 2026-10-18 (sandbox clock). Scope: the whole application, Phases 0–5, a final security-and-bug pass, and the optional extras added afterwards (§6b).
This report separates what was **verified** (command and result given), what was **partially** verified, and what **could not be verified** here. Nothing below is claimed beyond that.

## 1. Verdict

* **As software, locally:** the application builds, passes every automated check that exists (822 unit/integration tests, 101 browser tests, static analysis, dependency audit for shipped code, a restore drill, a local load test, database and smoke verifications), and the final passes found and fixed the defects listed in §5.
* **As a service you can launch today: no.** It has **never run on Vercel, Neon, Resend, Google, Discord or Vercel Blob**, and no restore has been tested on a real Neon plan. Those are explicit **go-live blockers** (§4). Everything else is in good shape to hand over, with the limitations listed in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## 2. Commands run and their results

All against PostgreSQL 16.15 on a local cluster, Node 22.22, pnpm 10.28, Chromium (Playwright 1.64). Results are from the final state of the branch `claude/phase0-proposal`.

| Command | Result |
|---|---|
| `pnpm lint` | clean (no errors, no warnings) |
| `pnpm typecheck` | clean |
| `pnpm test:unit` | **288 / 288 passed** |
| `TEST_DATABASE_URL=… pnpm test:integration` | **534 / 534 passed** |
| `pnpm build` | compiled successfully (all pages, 69 API routes, proxy, instrumentation) |
| `pnpm exec playwright test tests/e2e` (fresh database, Chromium) | **101 / 101 passed** (12 spec files, ≈ 4.8 min), run with the defaults: automatic e-mail off, no cron calling the app except where a test calls it |
| `pnpm audit --prod` | **No known vulnerabilities** |
| `pnpm audit` (incl. dev tools) | 1 high: `braces` ≤ 3.0.3 via ESLint tooling, dev-only, no patched version listed — **accepted**, see [SECURITY.md](SECURITY.md) §3 |
| `pnpm backup:restore-test` | **22 / 22**: dump 189 522 bytes → restore → 9 structure comparisons identical, **43 tables / 709 rows with identical content checksums** (re-run on the final state, 16 migrations), each tenant sees only its own rows through the restored least-privilege role, audit log still append-only |
| `pnpm verify:database` (runtime role, E2E database) | **15 / 15** (also correctly *fails* for a superuser connection, and for a runtime role whose grants were not re-applied after migration 0014 or 0015: 14/15) |
| `pnpm smoke` (local production server) | **17 / 17** (measured before the registration switch was added; the script is unchanged and was not re-run since) |
| `scripts/backup.sh` with encryption | dump → AES-256 → checksum → decrypt → `pg_restore --list` verified; wrong passphrase rejected; refuses a role without `BYPASSRLS` (exit 3) |
| Mutation checks (see [TESTING.md](TESTING.md)) | 42 deliberate breakages (6 on the original code, 36 on the extras), each caught by a test. Two of them were **not** caught at first (a work budget and a signal fingerprint) and the tests were made discriminating |

Test inventory: 288 unit + 534 integration + 101 end-to-end = **923 automated tests**. Source ≈ 13 400 lines, tests ≈ 10 000 lines (TypeScript, excluding scripts).

Also run: `pnpm load` (60 000 tasks, 10 and 50 concurrent users, 0 errors; [TESTING.md](TESTING.md#load-test-pnpm-load)), the error-reporting delivery check against a local HTTPS stand-in for the tracker, and by-hand runs of `pnpm org` (export → `--replace` round trip on the E2E data: identical), `pnpm backup:attachments` and `pnpm privacy` against the E2E database with the least-privilege role.

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
| Secure attachment access | ✅ filesystem store, ⚠️ Blob | Content sniffing, private download route, headers, byte-exact round trip, cap race fixed. **4 MB through the server; up to 25 MB by direct browser → Blob upload** (token bound to one object name/size/type, server-side inspection of the stored object: 14 tests, 5 deliberate breakages caught). The Vercel Blob client and the browser → Blob request are **type-checked / read from SDK source only, never run**; `DIRECT_UPLOADS=off` is the kill switch. |
| Audit retention and deletion behaviour | ✅ | 90-day floor enforced **in the database**; 30-day trash; purge job tested end to end; append-only proven for the runtime role. |
| Backup and a successful restore test | ⚠️ | **Local drill passed (above).** Neon’s own backups / point-in-time restore: unverified. Blob content: `pnpm backup:attachments` (hash-verified, incremental; tested with two filesystem stores, **not** with Blob). One organization can be exported/imported (`pnpm org`, tested across two real databases, never on Neon). A scheduled backup job is not in the repository. |
| Test suite, type check, lint, production build, deployment configuration | ✅ locally, ⚠️ deployment | `vercel.json` (cron once a day, so it fits Vercel Hobby) and `vercel.pro.json` (every minute) never deployed; plan limits are from memory and could not be checked against Vercel's site from the build machine. |
| Operational documentation and known limitations | ✅ | 16 documents; derived parts (permission matrix, ERD) are generated and guarded by tests. |

## 4. Go-live blockers (clear all before real users)

1. **Deploy to a real Vercel project with a real Neon database**, run `pnpm verify:database`, `pnpm smoke`, and the manual checklist in [DEPLOYMENT.md](DEPLOYMENT.md) §8. Until then the integrations are untested in the only environment that matters.
2. **Choose the e-mail mode for your plan.** The default (automatic e-mail switched off) runs on Vercel Hobby: in-app notifications work when people use the app, and an administrator sends the waiting e-mails. For automatic e-mails an administrator switches them on in Settings → Notifications, and something has to run the background work regularly: your own server's per-minute cron, a plan that runs Vercel's cron every minute (`vercel.pro.json`), or an external scheduler. Confirm the plan's real limits yourself.
3. **Backups on your actual Neon plan:** record the restore window, create a **dedicated `BYPASSRLS` backup role** (a plain owner cannot `pg_dump` this schema), schedule `scripts/backup.sh` somewhere that has `pg_dump`, and **perform a restore into a scratch database** ([BACKUP_RESTORE.md](BACKUP_RESTORE.md) §5). Decide where the attachment-file backup lives and run `pnpm backup:attachments` once (a second Blob store or a directory; the Blob implementation has never run).
4. **Verify Resend end to end** (domain verified, a real message delivered), and Google/Discord if you intend to use them.
5. **Secrets hygiene:** `APP_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` stored outside Vercel as well; preview deployments isolated from production data.
6. **Name a security contact and an incident owner** (none is configured).
7. **Monitoring:** an uptime check on `/api/health/ready` and log alerting. Error reporting is optional (`SENTRY_DSN`, redacted events): its delivery was verified against a local HTTPS stand-in, **not a real tracker**. No APM.
8. **Large uploads:** run the 10–20 MB upload check in [DEPLOYMENT.md](DEPLOYMENT.md) §8 (CSP host `vercel.com/api/blob/`, private store accepting client tokens). If it fails, set `DIRECT_UPLOADS=off`.
9. **Operator role for `pnpm org`:** it needs `BYPASSRLS` (same as `pg_dump`); create it deliberately and keep it off the application.

## 5. Defects found and fixed in the final passes

Security: owner-bound RLS gaps (bootstrap / system-role sync / audit retention failing for a plain owner), `pg_dump` impossible for such an owner (now pre-checked), RLS role never enforced at runtime (now a production guard), missing CSP and security headers, no request ids, readiness blind to migrations, **HTTP 500 on NUL characters** (every route), calendar-connect answering before the membership check, irreversible actions without confirmation.
Correctness: UI “today” in the wrong time zone, MFA backup codes unusable at sign-in, **attachment cap exceeded under concurrency**, **bulk-update deadlock**, refused custom-field value discarded from the form, stale member list.
Accessibility / layout: label-in-name on icon buttons, calendar grid roles, keyboard-unreachable scroll regions, off-screen menu in the tab order, mobile horizontal overflow from absolutely-positioned text.
Details and evidence: [SECURITY.md](SECURITY.md) §4, [TESTING.md](TESTING.md).

**Found in the whole-system security re-check and the independent review that followed it (all fixed, each with a test that failed first; full list in [SECURITY.md](SECURITY.md) §4 items 18–19):** the sign-in throttle could be sidestepped by forging `X-Forwarded-For` or by sending a form-encoded body; an **open redirect after sign-in** (reproduced in Chromium); **a bare `http://` in a comment crashed the task drawer for everyone who opened it**; Better Auth accepted display names of any length; **old invitations let suspended or removed people back in**; links in e-mail/Discord/calendar pointed to a page that does not exist; organization export silently dropped tables the role could not read; plus smaller permission, key-spelling, configuration, script and documentation fixes (rotating `BETTER_AUTH_SECRET` also breaks two-factor, now documented and recoverable with `pnpm auth:reset-2fa`). Four reviewers read the code independently; they, like the author, ran nothing against real Vercel, Neon, Resend, Google, Discord or Blob. Items they reported that were not reproduced or changed are listed in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

**Found while building the optional extras (§6b), all fixed:** query parameters and user text leaking into error logs through Drizzle's and PostgreSQL's error messages (and through a stack trace that began with the multi-line message); an infinite re-subscription loop in the new change-signal hook (a non-memoized `subscribe` restarted polling on every render; caught because pages never became network-idle); a write-back race where merely opening a page re-saved the profile language and could overwrite a newer choice (caught as an intermittent end-to-end failure, fixed by never writing when syncing from the server); N+1 queries in the people lookup (3 per member) and in notification rendering (≈ 7 per notification); a dashboard doing four scans; a new route answering before it checked tenancy (caught by the cross-tenant sweep); and two tests that could not fail (a work budget and a signal fingerprint) which were made discriminating after a deliberate breakage passed them.

## 6. What was added in Phase 5

* **Retention:** daily purge job (trash, deleted attachments/comments/destinations, operational rows, expired auth artefacts), weekly orphan sweep, 90-day audit floor in the database — [RETENTION.md](RETENTION.md).
* **Operations:** backup script and restore drill, attachment verifier, key-rotation tool, database and HTTP deployment checks, health/readiness endpoints, request ids, route-level rate limits, RLS runtime guard.
* **Security hardening:** nonce-based CSP, security headers, NUL-byte rejection, production cookie verification.
* **Product gaps closed:** recurring-tasks screen, backup-code sign-in, confirmations, accessibility fixes.
* **Documentation:** the full set required by the brief, with generated parts guarded by tests.
* **Migrations:** `0010` indexes, `0011` retention controls, `0012` owner bootstrap policies, `0013` the `tasks (org_id, updated_at)` index (15 in total, with `0014` the registration switch).

## 6b. Optional extras added after the first pass (each with tests and a deliberate-breakage check)

| Extra | Status |
|---|---|
| Change password for signed-in users (Security page, other devices signed out on request, rate limited) | ✅ integration + browser |
| Error boundaries (`error.tsx`, `global-error.tsx`, `not-found.tsx`), request-error hook, **redacted** error reporting (Sentry protocol, optional) | ✅ locally; ⚠️ delivery checked against a stand-in tracker only |
| Personal data export + account erasure (UI + `pnpm privacy`) | ✅ integration (9) + browser (private use among agreeing friends; no legal review sought) |
| Per-organization export/import / partial restore (`pnpm org`, encrypted bundle option) | ✅ two real databases (18 tests) + by hand on E2E data; ⚠️ never on Neon (needs a `BYPASSRLS` role) |
| Attachment file backup/restore (`pnpm backup:attachments`) | ✅ two filesystem stores (6 tests); ⚠️ Blob implementation never run |
| Direct browser → Blob uploads up to 25 MB | ✅ token + server-side inspection (14 tests); ❌ browser → Vercel Blob request unverified |
| Safe Markdown in comments and descriptions | ✅ unit (67 incl. XSS corpus and a timing guard) + browser |
| Change-signal refresh instead of 20–60 s timers (still polling, not push) | ✅ integration (11, permission-aware) + unit (9) + two-browser test; ⚠️ not real-time push |
| Load test (`pnpm load`) and the fixes it led to; migration 0013 (index) | ✅ local shape check only |
| Firefox / WebKit end-to-end runs | ⚠️ configured (`pnpm test:e2e:browsers`), **never run** |

## 7. Known limitations and decisions

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md): the unverified Blob direct upload, change-signal polling (not push), the Chromium-only test runs, a local-only load test, no APM, erasure/export built for private use among agreeing friends, with no legal review, and the decisions left to the owner.

## 8. Repository state

Branch `claude/phase0-proposal` is pushed to `origin` (Pittzaa/Task-detect). **No pull request exists**: the repository has no `main` branch to target and an earlier attempt to create one was blocked, so a base branch must be created (or chosen) by the owner before a PR can be opened.
