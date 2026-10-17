# Task Tracker

Multi-tenant organization task tracker (Next.js on Vercel, Neon PostgreSQL, Resend). See
[`docs/PHASE0_PROPOSAL.md`](docs/PHASE0_PROPOSAL.md) for the architecture proposal and phase plan.

**Status: Phase 1 in progress.** Implemented so far: tooling, schema, migrations, scoped RBAC
evaluator, tenant isolation (application + row-level security) and tests. **Not implemented yet:**
authentication, account approval/invitation flows, sessions, and any product UI. See
[`docs/PHASE1_STATUS.md`](docs/PHASE1_STATUS.md).

## Prerequisites
- Node.js >= 22, pnpm 10
- PostgreSQL 16 for local/integration testing (production target is Neon)

## Commands
| Command | Purpose |
|---|---|
| `pnpm install` | install dependencies |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm lint` / `pnpm typecheck` | static checks |
| `pnpm test:unit` | pure-logic tests, no database |
| `pnpm test:integration` | needs `TEST_DATABASE_URL` (see `docs/TESTING.md`) |
| `pnpm db:generate` | generate a SQL migration from `src/db/schema.ts` |
| `pnpm db:migrate` | apply migrations over `DATABASE_URL_UNPOOLED` |

## Layout
```
src/authz/   permission catalog + pure evaluator
src/data/    tenant session (withTenant) and tenant-scoped services
src/db/      Drizzle schema and client
src/lib/     errors, logger (secret redaction)
drizzle/     versioned SQL migrations
scripts/     migration runner, runtime-role grants
tests/       unit/ and integration/
docs/        design and operations documents
```
