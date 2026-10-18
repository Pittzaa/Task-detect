# Testing

Everything here was run on the release candidate; the exact results are in [READINESS_REPORT.md](READINESS_REPORT.md). **No test touches a real third-party service** (Resend, Google, Discord, Vercel, Neon): those are represented by fakes and a local PostgreSQL, so passing tests prove our logic and our handling of the documented request shapes, not that the live services accept our requests. Use the deployment scripts for that ([DEPLOYMENT.md](DEPLOYMENT.md) §8).

## Commands

```bash
pnpm lint                      # ESLint (React hooks rules included)
pnpm typecheck                 # tsc --noEmit
pnpm test:unit                 # 163 tests, no database
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/tasktracker_test pnpm test:integration   # 340 tests
pnpm test:e2e                  # builds, then 78 browser tests (Chromium) against a production build
pnpm build                     # production build
pnpm audit --prod              # known vulnerabilities in shipped dependencies
pnpm backup:restore-test       # dump → restore → compare → prove isolation on the restored copy
pnpm docs:generate && pnpm docs:erd   # regenerate derived documentation (a unit test fails if it drifts)
```

Local PostgreSQL for the tests (no Docker needed): a PostgreSQL 16 cluster on port 54329, e.g.
`pg_ctl -D /var/lib/pgtest/data -o '-p 54329 -k /tmp' start`, with a trust-authenticated `postgres` superuser and a database whose name contains `test`.

## Layers

| Layer | Where | Notes |
|---|---|---|
| **Unit** | `tests/unit` | Pure rules: permission evaluator, workflow, dependency graph, recurrence, time zones/DST, notification policy, file sniffing, i18n completeness, crypto, CSP, env validation, Discord URL validation, documentation drift. |
| **Integration** | `tests/integration` | Real PostgreSQL, the **least-privilege runtime role** (`NOSUPERUSER NOBYPASSRLS`) for code under test, a superuser only for fixtures. Global setup rebuilds the schema from the migrations, creates the role and applies `scripts/grants.sql`. Route handlers are also called in-process. |
| **End-to-end** | `tests/e2e` | Playwright + Chromium against `next start` of the production build, a fresh database (`scripts/e2e-setup.ts`), and a file e-mail sink. **The specs run in order against one database** (`01-onboarding` creates the users the later ones use), so run them together; `E2E_KEEP_DB=1` re-uses the database to iterate on one spec, but specs that create things (invitations, destinations) then need a clean run. |

## What each area proves

| Area | Evidence |
|---|---|
| Tenant isolation | `tenant-isolation` (19: sessions, unfiltered queries under RLS, constraints, append-only audit), `rbac`, E2E `04-security` (cross-tenant URL/API/search), **E2E `08-route-sweep`** (every route × every method as another tenant’s administrator: never 2xx, never 5xx, no content leaked) |
| Authorization | `evaluate`, `permissions`, `rbac`, `account`, `tasks` (42), `productivity` (bulk per-record), `context`; E2E viewer and scoped-role tests (`02`, `07`, `10`) |
| Authentication | `auth` (18), `auth-hardening` (Secure cookies in a production tier, mass assignment), E2E `01`, `04` (2FA incl. backup code), `09` (password reset revokes other sessions, open-redirect, suspension takes effect immediately) |
| Workflow, dependencies, subtasks | unit `workflow`, `graph`; `tasks`; E2E `02` |
| Search / views / bulk / custom fields | `productivity`, `custom-fields`, `data-quality` (stable paging, wildcard escaping, Thai text), E2E `03`, `10` |
| Recurrence and time zones | unit `recurrence`, `time`; `series`, `reminders-digest`; E2E `07`, `05` (Buddhist Era, profile zone) |
| Notifications, e-mail, Discord, Calendar | `notifications`, `reminders-digest`, `discord`, `calendar` (29, fake Google: duplicate prevention, one-way, revoked credentials); E2E `03` (mention → tick → bell + mail) |
| Jobs | `queue` (leases, retries, dead letter, deferral, rolling deploys), `concurrency` |
| Attachments | `attachments-http`, unit `files`, E2E `02` |
| Retention, backup, operations | `retention`, `owner-role`, `verify-attachments`, `rotate-encryption`, `ops`; `pnpm backup:restore-test`; `pnpm verify:database`; `pnpm smoke` |
| Robustness | E2E `08`: > 500 malformed-id/body calls and > 400 hostile query strings across all routes, NUL characters, invalid JSON — no 5xx |
| Accessibility / responsive / i18n | E2E `05`: axe (WCAG 2.0/2.1 A and AA) on every page and dialog in light and dark, keyboard focus trap and skip link, 375 px layouts without horizontal scroll, Thai/English |
| Browser security | E2E `06`: nonce CSP, headers, injected markup blocked, framing blocked, health endpoints, request ids, rate limits |
| Account erasure and data export | `privacy` (9: refusals change nothing — wrong e-mail/password, platform admin, sole administrator in a second organization rolls the whole transaction back; what is removed and what stays; export holds no credentials and counts what the user can no longer open), E2E `09` (real download, wrong inputs, real erasure, sign-in impossible afterwards). Three deliberate breakages were caught. |
| Error reporting and log redaction | unit `error-report` (24: DSN parsing, redaction, dedupe, budget, failure swallowing), integration `error-reporting` (a **real driver failure** is logged and sent without its parameters), E2E `09` (friendly not-found page) |
| Per-organization export/import | `org-transfer` (18, two real databases: round trip, `--replace` leaves other tenants untouched, all-or-nothing, tamper/schema/passphrase checks, users arrive without credentials and regain access through "forgot password", chunk ordering). Four deliberate breakages caught; also run by hand on the E2E data (38 tasks, 143 audit rows) with an identical round trip. |
| Attachment file backup | `backup-attachments` (6, two filesystem stores: incremental, never copies a damaged source over a good copy, restore after total loss, `--verify`, never deletes). Three breakages caught. The Blob store itself is not exercised. |
| Direct large uploads | `direct-upload` (14): token bound to one name/size/type/no overwrite (decoded and asserted), permission/tenant checks, server-side inspection of the stored object (type from bytes, 25 MB cap, empty, missing, idempotent, race on the 25-file cap), HTTP routes. Five breakages caught. **The browser → Vercel Blob request is not tested.** |
| Markdown | unit `markdown` (67): formatting, "plain text stays plain", link rules, a 37-payload XSS corpus checked structurally, resource limits with timing (the test fails without the work budget), E2E `02` |

## Mutation checks run manually (a test that cannot fail proves nothing)

| Change made temporarily | Result |
|---|---|
| Disable RLS on `projects` | 4 tests failed |
| Make `can()` always true | 19 tests failed |
| Lower the audit-retention floor from 90 to 1 | the floor test failed |
| Remove the “no child rows” guard in the purge | purge aborted for the organization; 2 tests failed |
| (Found naturally) the audit-retention function before its owner-bound SELECT policy existed | the plain-owner test failed: the function deleted 0 rows instead of 2 |
| Corrupt a restore (alter one row, drop one policy) | the restore drill failed 2 of 20 checks |
| Erasure: skip the sole-administrator check, skip the session deletion, ignore project scope in the export | 4 of 9 privacy tests failed |
| Org export: leak another tenant's tasks; skip the system-role remap; load children before parents; import without a transaction | 6, 3, 2 and 2 tests failed respectively |
| Attachment backup: skip the source hash check; make the dry run write; ignore `--verify` | 2, 1 and 1 tests failed |
| Direct upload: no content sniffing; no size cap; accept any object name; leave rejected objects in the store; token allows overwrite/any type | 1, 1, 2, 2 and 1 tests failed |
| Markdown: accept any URL scheme; drop `rel`/`target`; disable the look-alike link warning; remove the work budget | 1, 11, 1 and 3 tests failed (the budget one only after the time limit was tightened: with the loose limit it passed, i.e. the test could not fail) |
| Change signals: ignore permissions; stop touching `updated_at` for labels; count everyone's notifications; skip the task access check on comments | 2, 1, 1 and 2 tests failed |
| Signal hub: no retention across leave-and-return | 1 test failed |

## Bugs the test suites found while being written (all fixed)

Local-time conversion east of UTC; series back-fill and soft-deleted occurrences holding the unique slot; the worker killing jobs it did not know; a custom field with `min > max` causing a 500; UI “today” computed in the wrong time zone; backup codes unusable at sign-in; owner-bound RLS gaps (bootstrap, retention); `/health/ready` blind to migrations; **NUL characters in text causing HTTP 500**; **attachment cap exceeded under concurrent uploads**; **two bulk updates deadlocking for 13 s and failing items**; calendar-connect answering before checking membership; a refused custom-field value being discarded from the form; **query parameters leaking into error logs** (Drizzle and PostgreSQL quote user values in error text; also a stack trace that began with the multi-line message); **an infinite re-subscription loop in the change-signal hook** (an inline `subscribe` function made React restart polling on every render; found by the existing end-to-end suite because the page never became network-idle), the cross-tenant route sweep catching a new route that answered 409 before checking membership, **N+1 queries in `listPeople`** (three queries per member), several WCAG defects (label-in-name, grid roles, unreachable scroll regions, off-screen menu in tab order, hidden text widening phones).

## Not covered

Load/performance, Firefox/WebKit/real devices, screen-reader sessions, penetration testing, real provider integrations, restore at production data volume. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
