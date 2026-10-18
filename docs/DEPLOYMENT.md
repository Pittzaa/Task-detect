# Deployment (Vercel + Neon + Resend)

> คู่มือภาษาไทยแบบทีละขั้น: [DEPLOYMENT_TH.md](DEPLOYMENT_TH.md)

> **Read first — what has and has not been verified.**
> Everything below the *database* line was exercised against a local PostgreSQL 16 and a local production build.
> **No real Vercel, Neon, Resend, Google or Vercel Blob account was available to the author**, so those integrations
> were never exercised end-to-end. Where this guide describes a provider's dashboard or plan limit it is written from
> general knowledge or search snippets and is marked **(verify)**. The sandbox could not read vercel.com or neon.com.
> The scripts in step 8 exist precisely so that *you* can prove the deployment on the real services in minutes.

## 0. Plans and limits that affect the design (verify each before relying on it)

| Topic | What the app assumes | Why it matters | Fallback |
|---|---|---|---|
| **Vercel Cron frequency** | Every minute (`vercel.json`). Reported: *Hobby* plans allow only daily cron, *Pro* allows per-minute **(verify)**. | Reminders, e-mail, Discord, calendar sync and digests are driven by `/api/cron/tick`. | On a plan that cannot run it every minute, either upgrade, or call `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every 1–5 minutes from any external scheduler. The job queue is durable, so a slow tick only adds latency; it never loses work. If a plan *rejects* the schedule at deploy time, change `vercel.json` accordingly. |
| **Function request body** | Files up to **4 MB** go through a function (`MAX_UPLOAD_BYTES`; Vercel functions reportedly reject bodies over ~4.5 MB **(verify)**). Larger files, up to **25 MB**, go **straight from the browser to Vercel Blob** (a short-lived token from `/attachments/direct`, then server-side inspection in `/attachments/direct/complete`); this is offered only when `BLOB_READ_WRITE_TOKEN` is set. | The direct path has **never been run against a real Blob store** (see the checklist in §8). | If the checks in §8 fail, set `DIRECT_UPLOADS=off` (files are then limited to 4 MB) or fix the CSP/CORS issue found there. |
| **Function duration** | The cron route declares `maxDuration = 60` and works in slices of ≤ 45 s; the retention job defers itself when it runs out of time. | A plan with a shorter limit would cut jobs off. | Jobs are leased and retried; lower `maxMs` in `src/jobs/tick.ts` if needed. |
| **Neon connections** | `DATABASE_URL` is the *pooled* string; interactive transactions go through the WebSocket driver (`@neondatabase/serverless` `Pool`). | Every request opens a transaction and sets tenant context with `set_config(..., true)` (transaction-local). | See *Neon* below. |
| **Neon backups** | Plan-dependent point-in-time restore window **(verify in the console)**. | See [BACKUP_RESTORE.md](BACKUP_RESTORE.md). | Daily logical dump with `scripts/backup.sh`. |
| **Resend** | Sending domain verified; free-tier daily limits apply **(verify)**. | Registration, invitations, reset, notifications and digests all use e-mail. | Check Resend limits for your expected volume. |

## 1. Prerequisites

* Node.js ≥ 22 and pnpm 10 on the machine that runs migrations (your laptop or CI).
* A domain you control (for `APP_URL` and for the Resend sending domain).
* `psql` available for the one-off role setup, or any SQL console.

## 2. Neon (database)

1. Create a project in the region **closest to your Vercel function region** (latency is paid on every query).
2. Note two connection strings: the **pooled** one (host contains `-pooler` **(verify)**) and the **direct** one.
3. The project’s default role is the **owner**. It is used for migrations, bootstrap and backups only.
4. Create the **runtime role** (never a superuser, never `BYPASSRLS`). In the SQL editor, as the owner:

   ```sql
   CREATE ROLE tt_app LOGIN PASSWORD '<long random password>' NOSUPERUSER NOBYPASSRLS;
   ```

   Tenant isolation depends on this: row-level security does not bind roles that bypass it. The application refuses to
   serve tenant data through such a role in production (`src/db/rls-guard.ts` → HTTP 503), and `pnpm verify:database`
   checks it explicitly. Build the runtime connection strings from this role’s credentials.
5. Run migrations as the owner (direct string), then apply the grants:

   ```bash
   DATABASE_URL_UNPOOLED='<owner direct string>' pnpm db:migrate
   psql '<owner direct string>' -v ON_ERROR_STOP=1 -c "$(sed 's/{{APP_ROLE}}/tt_app/g' scripts/grants.sql)"
   ```

   **Re-run the grants after every release that adds tables or functions** (migrations do not grant to the runtime role).
6. Create the system roles and the first organization (still as the owner; the bootstrap works for an owner without
   `BYPASSRLS` — covered by `tests/integration/owner-role.test.ts`):

   ```bash
   DATABASE_URL_UNPOOLED='<owner direct string>' pnpm bootstrap --name "Acme Co" --slug acme --admin-email admin@acme.example --app-url https://tasks.example.com
   ```

   It prints a one-time link (valid 7 days) for the first administrator. The `--slug` is the organization code members type
   on the “Request access” page.

**(verify)** Two Neon-specific behaviours were *not* testable locally: that transaction-local `set_config` survives the pooler
(it should: it lives inside one transaction), and what attributes Neon gives the default owner. `pnpm verify:database`
(step 8) tests the first against the real service and reports the second.

## 3. Resend (e-mail)

1. Add and verify your sending domain (DNS records Resend shows you: SPF/DKIM). Wait until it shows *Verified*.
2. Create an API key with *sending* permission.
3. Set `RESEND_API_KEY` and `EMAIL_FROM` (an address on the verified domain).

Delivery is idempotent (each message carries an idempotency key derived from the notification), failures are retried by the job queue, and bounces are not processed (see limitations).

## 4. Google (optional)

Two separate OAuth clients keep scopes minimal. In Google Cloud Console → *APIs & Services*:

* **Sign-in client** (`GOOGLE_CLIENT_ID/SECRET`): authorised redirect URI `https://<APP_URL host>/api/auth/callback/google`.
* **Calendar client** (`GOOGLE_CALENDAR_CLIENT_ID/SECRET`): enable the *Google Calendar API*; scope `https://www.googleapis.com/auth/calendar.events`;
  redirect URI `https://<APP_URL host>/api/calendar/callback`.

Google may require OAuth consent-screen verification before non-test users can authorise the calendar scope **(verify)**.
Calendar sync is **one-way** (this app → the user’s calendar): the client has no read function, so edits made in Google never flow back.

## 5. Vercel Blob (attachments)

Create a **private** Blob store, connect it to the project, and set `BLOB_READ_WRITE_TOKEN`. Objects are stored private, are
read only through the authenticated route `/api/orgs/:org/attachments/:id`, and are served with
`Content-Disposition: attachment`, `nosniff` and a sandboxing CSP. The Blob client code is type-checked against the SDK but
was **never run against a real store**; the filesystem store used by the tests implements the same interface.

## 6. Vercel (hosting)

1. Import the repository. Framework preset: Next.js. Install: `pnpm install`. Build: `pnpm build` (default).
2. Set the environment variables from [ENVIRONMENT.md](ENVIRONMENT.md) for the **Production** environment. Preview deployments must use a *separate* database
   and their own secrets. A Neon branch **copies the parent's data** (and, as far as is known, its roles): create it from an empty or scrubbed state and give the roles new passwords, or use an empty project. Never let a preview hold a copy of production data.
3. `vercel.json` registers the cron `GET /api/cron/tick` every minute. Vercel sends `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set.
4. Add the domain and set `APP_URL` to it **before** the first deploy (it is baked into e-mail links, the CSRF origin check and OAuth redirects).
5. Deploy. Do not run migrations in the build step: apply them deliberately (step 2.5) *before* promoting a release that needs them.

Order of operations for a release that contains migrations: **migrate → grants → deploy**. Migrations in this repo are additive and
backward compatible with the previous build, so the old build keeps working during the switch. The readiness endpoint reports a
build that is ahead of its database (`migrations` check) instead of failing on first use.

## 7. Domains, cookies and CSRF

* Session cookies are `HttpOnly` and `SameSite=Lax` (observed on a local response) and are marked `Secure` in production (`useSecureCookies` follows the deployment tier; the `Secure` flag itself was not observed over real https). Mutating API calls additionally require an `Origin` header equal to `APP_URL`.
* The content security policy and other security headers are set by `src/proxy.ts` and `next.config.ts`. Anything that must frame the app or load third-party scripts needs a deliberate change there.

## 8. Prove it on the real services

Run these **in order** after the first deploy. Each is read-only.

```bash
# 1. The database exactly as the application will see it (the runtime role's connection string)
DATABASE_URL='<runtime pooled string>' pnpm verify:database

# 2. The deployed site (liveness, readiness incl. migrations + RLS, headers, unauthenticated access, cross-origin refusal)
APP_URL=https://tasks.example.com CRON_SECRET='<secret>' pnpm smoke

# 3. Attachments match the database (after the first uploads, and after any restore)
DATABASE_URL='<runtime string>' BLOB_READ_WRITE_TOKEN='<token>' pnpm verify:attachments
```

Then walk through the manual checks, which no script can do for you:

* [ ] Register with a real address: the verification e-mail **arrives** (Resend) and the link signs you in.
* [ ] Sign in as the bootstrap administrator via the invitation link; create a department, team, project and a task.
* [ ] Upload and download an attachment (Blob): a small one (≤ 4 MB) **and a 10–20 MB one**. The large one is the only test of the direct browser → Blob path: open the browser console while uploading and confirm there is **no Content-Security-Policy error** for `vercel.com/api/blob` (if there is, the host in `src/lib/csp.ts` is wrong — send me the blocked URL), the progress text appears, the file shows up as an attachment with the right size and downloads byte-identical, and the object in the Blob dashboard is **private**.
* [ ] Assign a task to a second account: the in-app notification and the e-mail arrive (this proves the cron tick runs — check `Settings → Job health` if not).
* [ ] Add a Discord webhook (Settings), send a test event, confirm the message and that `@everyone` in a title is **not** a mention.
* [ ] Connect Google Calendar, give a task a due date, confirm exactly **one** event appears; change the date, confirm it moves rather than duplicates.
* [ ] Enable two-factor, sign out and back in with the code and with a backup code.
* [ ] If `SENTRY_DSN` is set: provoke one server error (it must be an unexpected 500, not a 4xx), for example by temporarily pointing `DATABASE_URL` at a closed port in a preview deployment, and confirm that **one redacted event** appears in the tracker with the request id from the response header. The delivery code has been run against a local HTTPS stand-in for the tracker (see [TESTING.md](TESTING.md#error-reporting-checked-in-the-real-server)); until this check passes, acceptance by a **real** Sentry/GlitchTip is unverified.
* [ ] Trigger a backup and a restore into a scratch database following [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## 9. Go-live checklist

**Blockers** (do not launch until every box is ticked):

- [ ] `pnpm verify:database` passes against the production runtime role.
- [ ] `pnpm smoke` passes against the production URL, including readiness (`status: ok`).
- [ ] The cron tick runs at the cadence you chose and `Job health` shows no dead or stuck jobs.
- [ ] A **real** backup exists *and a restore from it has been tested on your plan* (the local drill proves the procedure, not your provider’s service).
- [ ] The Neon point-in-time-restore window and the Vercel cron limits were checked against the plan you are actually paying for.
- [ ] Resend domain verified; a real e-mail was delivered to an inbox.
- [ ] `APP_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` are stored in a password manager separate from the deployment.
- [ ] Preview deployments cannot reach the production database.
- [ ] At least two people can administer the organization (last-admin protection prevents locking everyone out, but a second human is the real safeguard).

**Strongly recommended:**

- [ ] An uptime monitor calls `/api/health/ready` (with the bearer secret) every 1–5 minutes and alerts on non-200.
- [ ] Log drain / alerting on `"level":50` and `"job queue needs attention"` lines.
- [ ] `pnpm audit --prod` is clean (it was at release; re-run before launch).
- [ ] The accepted risks in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) have been read by the person accountable for the service.

## 10. Rollback

* **Application:** promote the previous deployment in Vercel (instant). Migrations are additive, so the previous build still works against the migrated database.
* **Database:** migrations are forward-only. To undo a bad migration write a new forward migration; for a disaster restore from backup ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
* **Bad key rotation:** put the old key back in `APP_ENCRYPTION_KEY_PREVIOUS`; nothing is overwritten unless it decrypts.
