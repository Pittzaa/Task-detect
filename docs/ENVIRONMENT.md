# Environment variables

All variables are server-side only. Never prefix with `NEXT_PUBLIC_`. Never commit values.

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | runtime (`src/db/client.ts`) | Neon **pooled** connection string. The role must be non-superuser and `NOBYPASSRLS`. |
| `DATABASE_URL_UNPOOLED` | for migrations | `scripts/migrate.ts`, `drizzle.config.ts` | Neon **direct** connection string. |
| `LOG_LEVEL` | no (`info`) | `src/lib/logger.ts` | |
| `TEST_DATABASE_URL` | for integration tests | `tests/integration/*` | Superuser URL of an **isolated** database whose name contains `test`. It is wiped on every run. |

Validation lives in `src/config/env.ts`; errors name the variable but never print its value.
Variables for Resend, Google OAuth, Discord, storage and auth are added in later phases.
