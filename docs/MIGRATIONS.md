# Migrations

- Schema source: `src/db/schema.ts`. Migrations are versioned SQL in `drizzle/`, committed to git.
- Change the schema: edit `schema.ts`, run `pnpm db:generate`, **review the SQL**, commit both.
- Hand-written SQL (RLS, functions): `pnpm exec drizzle-kit generate --custom --name <name>` and fill the file.
  Separate statements with `--> statement-breakpoint`.
- Apply: `pnpm db:migrate` using the direct (non-pooled) connection. Never edit an applied migration.
- After the first migration in an environment, run `scripts/grants.sql` (replace `{{APP_ROLE}}`) as the
  owner so the runtime role has least privilege. Re-run after migrations that add tables.
- Rollback: not automated. Write a forward migration; restore from backup for disasters (`BACKUP_RESTORE.md`, Phase 5).

Current migrations
- `0000_*`: tables, constraints, indexes.
- `0001_rls_policies`: row-level security and the `app_org_id()` / `app_user_id()` helpers.
