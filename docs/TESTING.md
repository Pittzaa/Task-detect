# Testing

## Commands
```
pnpm lint
pnpm typecheck
pnpm test:unit
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/tasktracker_test pnpm test:integration
pnpm build
```
Integration tests need a real PostgreSQL superuser connection to a throwaway database whose name contains
`test`. The global setup drops and recreates the `public` schema, applies migrations, creates a
least-privilege role (`tt_app_test`, `NOSUPERUSER NOBYPASSRLS`), applies `scripts/grants.sql`, and seeds
system roles. Tests then use the **admin** connection only for fixtures and the **app** role for the code
under test, so row-level security is exercised as it would be in production.

## What is covered (Phase 1a)
- Unit: permission evaluator (scopes, union, deny-by-default, cross-org, account states), catalog
  invariants, logger secret redaction, env validation.
- Integration: cross-tenant session/lookup/write attempts, RLS with and without filters, composite-FK and
  CHECK constraints, append-only audit log, role/scope permission matrix, denial auditing and rollback.
- Mutation checks run manually: disabling RLS on `projects` fails 4 tests; making `can()` always true
  fails 19 tests. (Not automated.)

## Not covered / limitations
- Not run against Neon, only a local PostgreSQL 16. Behaviour of `set_config(..., true)` through Neon's pooler
  and Neon's default role privileges (BYPASSRLS) are **unverified**.
- No end-to-end, accessibility or load tests yet; no authentication tests (auth not built).
