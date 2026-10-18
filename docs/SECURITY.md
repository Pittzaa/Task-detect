# Security

This document states what the application does to protect tenants, **how each claim was checked**, and what is *not* covered.
It does not claim the application is “secure”: it reports the scope and results of the checks that were actually performed.
Evidence column: **T** = automated test (file), **E** = browser E2E, **M** = manual/mutation check run once, **C** = code review only, **—** = not verified.

## 1. Assets and actors

| Asset | Why it matters |
|---|---|
| Tenant data (tasks, comments, attachments, members) | Confidentiality between organizations is the core promise. |
| Credentials, sessions, 2FA secrets | Account takeover. |
| Integration secrets (Discord webhook URLs, Google refresh tokens) | Posting as the organization / reading+writing a user’s calendar. |
| Audit log | Accountability. |
| Availability of the job queue | Reminders and notifications. |

Actors considered: an **anonymous visitor**; an **authenticated user of organization A** attacking organization B; a **member with a low role** attacking higher roles (privilege escalation);
an **organization administrator** (trusted within their organization only); **malicious content** (XSS via titles/comments/files); a **compromised application process** (the damage a bug or injection could do given its database role);
an **external party** abusing webhooks/OAuth (SSRF, forged callbacks). Out of scope: a malicious platform operator with database owner access, denial-of-service at network level, supply-chain compromise beyond dependency auditing.

## 2. Controls and evidence

### 2.1 Tenant isolation (two independent layers)

| Control | Evidence |
|---|---|
| Every tenant operation goes through `withTenant()`: it authenticates the *user id*, verifies an **approved** membership of the *requested* org (the id from the URL is only a request), loads that user’s role assignments, then sets the transaction-local database context. Non-members, pending, suspended and revoked users get **404** (existence is not disclosed). | T `tenant-isolation.test.ts`, `rbac.test.ts` · E `04-security` (cross-tenant URL/API/search probes) |
| **PostgreSQL row-level security**, `ENABLE` + `FORCE`, on every tenant table, keyed to `app.org_id`. Queries written *without* an org filter still return only the current org (tested by running unfiltered queries). | T `tenant-isolation.test.ts` · `pnpm verify:database` checks FORCE RLS on every table |
| Composite foreign keys `(org_id, id)` make a cross-tenant reference impossible at the schema level; CHECK constraints guard task invariants. | T `tenant-isolation.test.ts` (“database constraints”) |
| The runtime role is `NOSUPERUSER NOBYPASSRLS`; in production-like tiers the app **refuses to serve (503)** if the connected role bypasses RLS. | T `ops.test.ts` · `pnpm verify:database` |
| Scope resolution (which department/team/project a task belongs to) always comes from the database, never from the request. | C · T `rbac.test.ts` |
| Foreign ids smuggled into your own org’s URLs (another tenant’s task id/project id) return 404 for read, write and status change. | E `04-security` (10 probes + 2 writes) |
| Notifications store identifiers only; text is rendered at read time after a **fresh access check**, so losing access removes the content. Search, saved views, dashboard, calendar and timeline apply the same permission filter. | T `notifications.test.ts`, `productivity.test.ts` |

### 2.2 Authorization (RBAC)

Scoped role assignments (`organization | department | team | project`), union of rights, **deny by default**, no explicit denies; see [RBAC.md](RBAC.md). Controls: no privilege escalation (you cannot grant a role holding permissions you lack),
last-administrator protection (advisory lock; an administrator cannot demote/suspend themselves into lock-out), per-record authorization in **bulk actions** with per-item results (partial failure is reported, never hidden), custom-role permissions validated against the catalog.
The UI hides controls the user cannot use, but **the server re-checks every action**; the browser tests drive the API directly as a viewer and are refused (E `02-task-lifecycle`, `07-recurring`). `superadmin` is only a flag and grants **nothing** inside any organization.
Evidence: T `rbac.test.ts`, `account.test.ts`, `tasks.test.ts` (42), `productivity.test.ts` (bulk), unit `evaluate.test.ts`/`permissions.test.ts`; M disabling RLS on `projects` failed 4 tests, making `can()` always true failed 19.

### 2.3 Authentication and sessions

* Email + password (min 12, max 128 characters), **email verification required before sign-in**, Google sign-in optional, TOTP two-factor with **backup codes** (single use; the sign-in page offers them) — T `auth.test.ts` (18), E `01-onboarding`, `04-security`.
* Self-registration is gated by **administrator approval**; invitations are one-time, expire in 7 days, are bound to the invited e-mail address, and are stored **hashed** — a stranger cannot redeem someone else’s link (E `04-security`/`01-onboarding`, T `account.test.ts`).
* Session cookies: `HttpOnly`, `SameSite=Lax`; in a production tier also `Secure` with the `__Secure-` prefix (T `auth-hardening.test.ts`); 7-day sessions refreshed daily; the user can list and revoke sessions and sign out other devices (E `04-security`). Password reset invalidates by token expiry (Better Auth defaults, C).
* **No account enumeration** on the paths probed live on 2026-10-17: wrong password vs unknown user return the identical `401 Invalid email or password`; password-reset returns the identical message for known and unknown addresses; the organization-code form answers identically for valid and invalid codes (E `01-onboarding`); sign-up for an existing e-mail returns a normal-looking success with a synthetic user. M.
* Brute-force limits (database-backed, work across serverless instances): sign-in 5/min, sign-up 10/h, reset request 5/h, TOTP and backup-code verification 5/min, verification e-mail 5/h; application limits: join 5/h, invite 50/h, accept 10/h, upload 20/min, bulk 20/10 min, search 120/min, task create 120/min, comment 60/min, calendar connect 10/h. T `auth.test.ts`, E `06-hardening` (search → 429 `RATE_LIMITED` at the 121st call).
* **CSRF:** mutating API calls require an `Origin` header equal to the configured `APP_URL`; a foreign or missing origin gets 403 (E `04-security`, `pnpm smoke`). Combined with `SameSite=Lax` cookies.

### 2.4 Browser-side protections

* **Content-Security-Policy with a per-request nonce and `'strict-dynamic'`**, no `unsafe-inline`/`unsafe-eval` for scripts in production, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. Inline *style attributes* are permitted (`style-src-attr`) because the UI uses them; style elements need the nonce.
  `'strict-dynamic'` deliberately lets already-trusted scripts create scripts; what the policy stops is injected **markup** (inline handlers, `javascript:` URLs) — the E2E test injects both and the browser blocks them and reports the violation. E `06-hardening` (headers, unique nonces, no violations on 11 page types, injected-markup test, framing test).
* `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation, payment, usb off), `Cross-Origin-Opener-Policy: same-origin`, HSTS in production, `x-powered-by` removed. E `06-hardening`.
* **No HTML or Markdown rendering of user text.** Titles, descriptions and comments are rendered as plain text by React; an `<img onerror>` payload and `<script>` in a comment are shown literally and never execute (E `02-task-lifecycle`). Mentions are structured ids, not parsed from text.
* Open redirect: the sign-in `next` parameter accepts only same-site relative paths, rejecting `//host` and backslashes (C; not covered by an automated test).

### 2.5 Files

Server-side upload (≤ 4 MB, ≤ 25 per task) with **content sniffing**: the type is decided from the bytes and must agree with the extension; SVG, HTML, scripts and archives are rejected; filenames are sanitized and never used for storage — keys are opaque server-generated paths.
Downloads go through an authenticated, permission-checked route and are sent as `attachment` with `nosniff` and a sandboxing CSP; the Blob store itself is private. T `attachments-http.test.ts`, unit `files.test.ts`, E `02-task-lifecycle` (png round-trip byte-for-byte; html refused).
**Not done:** malware scanning, previews/thumbnails (so no image-decoder attack surface), and **file contents are not covered by backups** (see [BACKUP_RESTORE.md](BACKUP_RESTORE.md)).

### 2.6 Secrets and integrations

* Discord webhook URLs are validated strictly (host allow-list, path shape, https, no userinfo/ports/redirects → **SSRF-resistant**), encrypted at rest with AES-256-GCM using AAD bound to the row, never returned by the API (only a hint like `…xyz`), never logged. Messages use `allowed_mentions: {parse: []}` (no `@everyone`), are generic unless the destination opts in to details, and the destination auto-disables on repeated or permanent failure. T `discord.test.ts`, unit `discord-url.test.ts`, `crypto.test.ts`.
* Google Calendar: OAuth with **PKCE and a hashed single-use `state`**, only the refresh token is stored (encrypted, AAD `cal:<id>`), event ids are deterministic (no duplicates on retry), sync is **one-way** (the client has no read function). T `calendar.test.ts` (29) against a **fake Google** — see §5.
* **Key rotation:** set the new key as `APP_ENCRYPTION_KEY`, the old as `APP_ENCRYPTION_KEY_PREVIOUS`, deploy, run `pnpm rotate:key` (re-encrypts every webhook and refresh token; reports any value no key can decrypt and never overwrites it), then drop the previous key. T `rotate-encryption.test.ts`.
* Logs are structured JSON with key-based redaction of passwords, tokens, cookies, secrets and webhook URLs (T `logger-env.test.ts`). Job errors store only an error *class*, never a response body. Audit metadata holds counts/ids, not content.

### 2.7 Database-level protections beyond RLS

* **Audit log is append-only for the application** and cannot be shortened below 90 days even by a compromised application ([RETENTION.md](RETENTION.md)). T `tenant-isolation.test.ts`, `retention.test.ts`, `owner-role.test.ts`; `pnpm verify:database`.
* The runtime role cannot create organizations or modify system roles, even when it sets the worker flag (it has no grant; the owner-only policies are bound to the migration role). T `owner-role.test.ts`.
* Task activity history is append-only for tenants; only the retention job, in worker context, can delete the history of tasks already in the trash. T `retention.test.ts`.

### 2.8 Availability and abuse

Durable Postgres job queue: leases, bounded retries with jittered back-off, dead-lettering, idempotent handlers keyed by dedupe keys, rolling-deploy safe (a worker claims only kinds it knows). Replay safety for outbox events, notifications, e-mail (idempotency key), Discord and calendar. Job health is visible in Settings and `/api/health/ready`. T `queue.test.ts` (16), `notifications.test.ts`, `reminders-digest.test.ts`.

## 3. Dependency and configuration review

| Check | Result (2026-10-17) |
|---|---|
| `pnpm audit --prod` | **No known vulnerabilities.** One moderate advisory (esbuild dev-server, via `better-auth → drizzle-kit → @esbuild-kit`) was removed with a `pnpm.overrides` pin to esbuild 0.25.12; `drizzle-kit generate` was re-run afterwards and still works. |
| `pnpm audit` (including dev tools) | **1 high advisory remains:** `braces` ≤ 3.0.3 (regex DoS) reached only through `eslint-config-next → fast-glob → micromatch`. It is lint tooling on developer/CI machines, is never bundled or run in production, and the advisory lists no patched version. **Accepted risk**, re-check before launch. |
| Peer-dependency warnings | `eslint-plugin-react` etc. declare support up to ESLint 9 while ESLint 10 is installed; lint passes. TypeScript is pinned to 6.x because typescript-eslint does not support 7. |
| Secure defaults | Production validation requires the secrets, an `https` `APP_URL`, forbids the e-mail sink, and treats a missing `APP_ENV` as production (`tests/unit/logger-env.test.ts`). |

## 4. Security review findings made during Phase 5 (all fixed and tested)

1. **Owner-bound RLS gap:** a plain database owner without `BYPASSRLS` could not run the bootstrap, sync system roles, or execute the audit-retention function, because `FORCE ROW LEVEL SECURITY` binds the owner too. Found by building a database owned by a plain role; fixed with owner-bound policies (migrations `0011`, `0012`) that do **not** widen the runtime role.
2. **`pg_dump` fails for such an owner** for the same reason (verified). `scripts/backup.sh` now checks the role first and explains.
3. **`/api/health/ready` could not read the migrations table** as the runtime role → readiness reported `down`; found by the E2E run, fixed by a read-only grant.
4. **Time zone:** the UI computed “today/overdue” in Asia/Bangkok instead of the user’s profile time zone; found by the E2E “My tasks” test, fixed.
5. **MFA recovery:** backup codes were generated but the sign-in page could not accept them; fixed and covered by E2E.
6. **Accessibility defects** found by axe: label-in-name on icon buttons, calendar grid roles, keyboard-unreachable scroll regions, off-screen menu in the tab order, absolutely-positioned screen-reader text widening mobile pages; all fixed.
7. **Row-level security was never enforced at runtime** (`checkRlsEnforceable` existed but nothing called it): now a guard in `withTenant`/worker contexts in production tiers.
8. **No security headers / CSP:** added (see §2.4). No request ids: added `x-request-id` (caller ids accepted only if they match `^[A-Za-z0-9-]{8,64}$`).

### Final test pass (route sweep, race tests, UI administration tests) — additional findings, all fixed

9. **HTTP 500 on a NUL character** in any text (`?q=%00`, a title containing `\u0000`): PostgreSQL cannot store it and the driver surfaced an internal error. Now rejected at every boundary with a 422 (`handle()`, `readJson`, and the Better Auth route). Found by the all-routes sweep.
10. **Attachment cap race:** simultaneous uploads from several users stored 28 files on a task capped at 25. The upload now locks the task row. Found by `concurrency.test.ts`.
11. **Bulk-update deadlock:** two bulk requests over the same tasks in opposite orders deadlocked (≈ 13 s) and reported items as `ERROR`. Rows are now locked in one global order and the version read is taken under the lock. Found by `concurrency.test.ts`.
12. **Calendar connect answered before the membership check** (a non-member could learn whether Google is configured). Order fixed; the sweep requires 404 for every route and method.
13. **Irreversible administrator actions had no confirmation** (revoke a member, delete a role / Discord destination / custom field): added.
14. **A refused custom-field value was thrown away** from the form instead of being kept for correction; fixed.
15. Verified rather than fixed: password reset **does** revoke all other sessions; sign-in `next` cannot redirect off-site (7 hostile forms tried); no permissive CORS headers or honoured preflights; suspension and role removal take effect on the very next request; mass assignment through sign-up / update-user / `PATCH /api/me` is ignored or refused.

## 5. What has NOT been verified

* **Any real third-party service.** Resend, Google (OAuth, Calendar API), Discord, Vercel Blob, Vercel Cron and Neon were never contacted. Their behaviour is represented by fakes (`tests/integration/google-fake.ts`, injected `fetch`, a file e-mail sink, an in-memory/filesystem object store). Mock-based tests prove *our* handling of the documented request/response shapes, not that the live service accepts the requests. Use `docs/DEPLOYMENT.md` §8.
* **Neon specifics:** transaction-local `set_config` through the pooler, the default owner’s attributes (`BYPASSRLS`), plan limits, point-in-time restore.
* **Penetration test / independent review:** none. The all-routes sweep sends > 500 malformed requests and cross-tenant probes with real ids, but it is a scripted regression test, not an adversarial human assessment, and there was no load or denial-of-service testing and no DAST scanner run.
* **What row-level security does and does not protect:** it stops *application bugs* (a forgotten `WHERE org_id`) from leaking data. It does **not** stop an attacker who can already execute arbitrary SQL as the runtime role, because that role can set the same session variables the application sets (`app.org_id`, `app.worker`). Preventing SQL injection is therefore the first line (all queries are parameterized through Drizzle; the source contains no `sql.raw` and no string-built SQL — checked by search), and database credentials must be protected like the data itself.
* **Browser coverage:** Chromium only (desktop and a 375 px viewport); Firefox/Safari not run. Screen readers were not used; axe covers the rules it can detect automatically (≈ 30–40 % of WCAG issues), so manual testing is still required.
* Password-hash parameters and token entropy are Better Auth defaults (C); invitation/state tokens are 256-bit random values (C).
* Malware scanning of uploads; e-mail bounce/complaint handling; WAF; per-IP rate limiting at the edge (limits here are per user/key in the database; Vercel/Cloudflare firewall rules are recommended in front).

## 6. Incident procedures

| Situation | Do this |
|---|---|
| **A user’s account is compromised** | Suspend their membership (Members → Suspend: takes effect on the next request, because membership is checked on every call), ask them to reset the password, then *Sign out other devices*. Review `Audit log` filtered to their actions. |
| **An integration secret leaked** (Discord URL) | Rotate the destination (Settings → Discord → Rotate) after revoking the webhook in Discord. Calendar: disconnect and revoke the app in the user’s Google account. |
| **`APP_ENCRYPTION_KEY` or `BETTER_AUTH_SECRET` leaked** | Rotate the encryption key with `pnpm rotate:key`; rotate `BETTER_AUTH_SECRET` (signs everyone out). Rotate the integration secrets themselves too if the database was also exposed. |
| **Database credentials leaked** | Change the Neon role passwords, update Vercel variables, redeploy; review recent audit entries; run `pnpm verify:database`. |
| **Suspected cross-tenant exposure** | Take the app offline (remove the production domain or rotate `DATABASE_URL` to an invalid value → 503), preserve logs (`x-request-id` correlates a user report with server logs), reproduce with a test in `tests/integration/tenant-isolation.test.ts`, fix, run the full suite and `pnpm smoke`, then restore service. |
| **Everyone locked out** | Use the operator bootstrap (`pnpm bootstrap …` issues a fresh administrator invitation for an existing organization). |
| **Job queue stuck/dead** | Settings → Job health, `/api/health/ready`; dead jobs are kept 30 days. Re-run the tick; fix the cause (usually a revoked credential). |

**Reporting:** no security contact address is configured in this repository. Decide one (for example `security@<your domain>`) and publish it before launch.
