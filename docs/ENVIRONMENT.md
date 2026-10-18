# Environment variables

All variables are **server-side only**. Never prefix one with `NEXT_PUBLIC_`, never commit a value, and never paste one
into a log, an issue or a chat. Validation lives in `src/config/env.ts`; its errors name the variable but never print
its value. A variable that is **set but blank** (`KEY=`) is treated as **not set**, so a copied `.env` file with empty
entries behaves as expected, and a blank *required* variable still fails validation.

## Deployment tiers (`APP_ENV`)

| `APP_ENV` | Meaning | Differences |
|---|---|---|
| unset | `production` when `NODE_ENV=production` (what Vercel runs), otherwise `development` | A deployment that forgets to set it gets the **strictest** rules. |
| `production` / `staging` | A real deployment | Requires the secrets below, `https` `APP_URL`, secure cookies, rate limits on, the database role is checked on use (`src/db/rls-guard.ts`), no email sink, attachment storage must be configured. `staging` has the same rules as production. |
| `development` / `test` | Local work and unit/integration tests | Lenient defaults, local filesystem store for attachments, log email sender. |
| `e2e` | Browser tests only (`playwright.config.ts`) | A *production build* served over http with a file email sink and no rate limits on auth. Never set this on a real deployment. |

## Reference

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `APP_ENV` | no | `src/config/env.ts`, `src/server/runtime.ts` | See above. |
| `APP_URL` | production | auth base URL, e-mail links, CSRF origin check, Google redirect URI | Public origin **without a trailing slash**, e.g. `https://tasks.example.com`. Must be `https` in production. Changing the domain changes the allowed origin. |
| `DATABASE_URL` | **always** | runtime (`src/db/client.ts`) | Neon **pooled** connection string for the **least-privilege runtime role** (`NOSUPERUSER NOBYPASSRLS`). Verify it with `pnpm verify:database`. |
| `DATABASE_URL_UNPOOLED` | for migrations, bootstrap, backups | `scripts/migrate.ts`, `scripts/bootstrap.ts`, `drizzle.config.ts`, `scripts/backup.sh` | Neon **direct** connection string for the **owner** role. Never give this to the running application. |
| `LOG_LEVEL` | no (`info`) | `src/lib/logger.ts` | `fatal error warn info debug trace silent`. Secrets are redacted regardless. |
| `BETTER_AUTH_SECRET` | production | session/cookie signing (`src/server/auth.ts`) | ≥ 32 random characters (`openssl rand -base64 48`). Rotating it signs everyone out. |
| `APP_ENCRYPTION_KEY` | production | AES-256-GCM encryption of Discord webhook URLs and Google refresh tokens | 32 random bytes, base64: `openssl rand -base64 32`. **Losing it makes stored webhooks/tokens unreadable** (they must be re-entered / re-connected). Back it up in your password manager. |
| `APP_ENCRYPTION_KEY_PREVIOUS` | during rotation | decryption fallback | See *Key rotation* in [SECURITY.md](SECURITY.md). Remove it after `pnpm rotate:key` reports no failures. |
| `RESEND_API_KEY` | production | e-mail delivery (`src/integrations/email`) | Resend API key with *sending* access. |
| `EMAIL_FROM` | production | e-mail sender | An address on a **domain verified in Resend**, e.g. `Task Tracker <no-reply@example.com>`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional | “Sign in with Google” | Set **both or neither**. The sign-in button appears only when both are set. |
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` | optional | Google Calendar one-way sync | Set **both or neither**. A *separate* OAuth client from sign-in so each asks only for the scopes it needs (`calendar.events`). Redirect URI: `${APP_URL}/api/calendar/callback`. |
| `CRON_SECRET` | production | `/api/cron/tick`, `/api/health/ready` | ≥ 16 random characters. Vercel Cron sends it as `Authorization: Bearer …` automatically when this variable exists. |
| `BLOB_READ_WRITE_TOKEN` | for attachments | `src/integrations/storage/blob.ts` | Vercel Blob **private** store token. Without it, production refuses uploads (attachments unavailable) instead of silently using an ephemeral disk. |
| `SENTRY_DSN` | optional | `src/lib/error-report.ts` | An **https** DSN of a Sentry-compatible tracker (`https://<key>@<host>/<project-id>`). When set, unexpected server errors are sent there as a redacted event (error class, database error code, constraint name, first stack frames, path without query string, request id; **no** message parameters, headers or cookies). Rejected in production/staging if not https. Unset = errors only go to the log. |
| `APP_RELEASE` | optional | `src/lib/error-report.ts` | Release label attached to reported errors; defaults to `VERCEL_GIT_COMMIT_SHA` when Vercel provides it. |
| `EMAIL_SINK_FILE` | never in production | `src/integrations/email` | Appends outgoing mail to a file for E2E tests. Rejected by validation in production/staging. |

### Test and tooling variables (never set on a deployment)

| Variable | Used by | Notes |
|---|---|---|
| `TEST_DATABASE_URL` | `pnpm test:integration` | **Superuser** URL of an isolated database whose name contains `test`. It is wiped on every run. |
| `E2E_DB_ADMIN_URL`, `E2E_APP_DATABASE_URL` | `scripts/e2e-setup.ts`, `playwright.config.ts` | Defaults point at the local test cluster on port 54329. |
| `E2E_KEEP_DB=1` | `tests/e2e/global-setup.ts` | Re-use the previous E2E database to iterate on one later spec. A normal run always starts empty. |
| `BACKUP_TEST_SOURCE_URL`, `BACKUP_TEST_ADMIN_URL` | `scripts/backup-restore-test.ts` | Source database and admin connection for the restore drill. |
| `BACKUP_PASSPHRASE` | `scripts/backup.sh` | Encrypts the dump (AES-256, PBKDF2). Keep it separate from the backups themselves. |
| `APP_URL` + `CRON_SECRET` | `pnpm smoke` | Where to point the post-deployment smoke test. |

## Where to set them

* **Vercel:** Project → Settings → Environment Variables. Use separate values per environment (Production / Preview /
  Development) and mark the secrets *Sensitive*. Preview deployments must **not** point at the production database.
* **Local:** copy `.env.example` to `.env.local` (git-ignored) and fill it in.

## Generating secrets

```
openssl rand -base64 48   # BETTER_AUTH_SECRET
openssl rand -base64 32   # APP_ENCRYPTION_KEY
openssl rand -hex 24      # CRON_SECRET
```
