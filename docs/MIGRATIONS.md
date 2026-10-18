# Migrations and schema changes

* **Schema source of truth:** `src/db/schema.ts`. **Migrations** are versioned SQL files in `drizzle/` (committed; never edited after they have been applied anywhere). 13 exist; `src/config/schema-version.ts` must equal that number (a unit test enforces it) and `/api/health/ready` compares it with the database.
* **Apply:** `pnpm db:migrate` with `DATABASE_URL_UNPOOLED` = the **owner’s direct** connection string. Then apply `scripts/grants.sql` (replace `{{APP_ROLE}}`) so the runtime role has least privilege. Order for a release: **migrate → grants → deploy** ([DEPLOYMENT.md](DEPLOYMENT.md) §6).
* **Make a change:** edit `schema.ts` → `pnpm db:generate` → **read the SQL** → commit both → bump `EXPECTED_MIGRATIONS` → regenerate docs (`pnpm docs:erd`, `pnpm docs:generate`).
* **Hand-written SQL** (RLS policies, functions, grants-like objects): `pnpm exec drizzle-kit generate --custom --name <name>`, fill the file, separate statements with `--> statement-breakpoint`. Every new tenant table needs `ENABLE` **and** `FORCE ROW LEVEL SECURITY` plus a policy; `pnpm verify:database` fails if one is missing.
* **Backwards compatibility:** migrations are additive during a release so the previous build keeps working against the new schema (needed for instant rollback of the application). Destructive changes (drop/rename) are done in two releases.
* **Rollback:** not automated. Write a forward migration; for disasters restore from backup ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
* **Owner-role rule:** policies written `TO CURRENT_USER` bind to the role that runs the migration. Run migrations, bootstrap and backups-that-need-RLS-bypass with the *same, documented* owner role. A plain owner without `BYPASSRLS` is supported and tested (`tests/integration/owner-role.test.ts`).
* **drizzle-kit gotcha:** stale `drizzle/meta/*_snapshot.json` files make `generate` produce wrong diffs. If a generated diff looks wrong, check `git status drizzle/meta` before accepting it.

## Applied migrations

| # | File | Contents |
|---|---|---|
| 0000 | `minor_james_howlett` | Core tables: organizations, users, memberships, departments, teams, projects, roles, assignments, invitations, audit log. Constraints and indexes. |
| 0001 | `rls_policies` | `app_org_id()` / `app_user_id()`, RLS on tenant tables, append-only audit log. |
| 0002 | `auth_tables` | Better Auth tables (sessions, accounts, verifications, two-factor, rate limits), app rate limits. |
| 0003 | `rls_auth_flows` | Policies for sign-up flows: organization lookup by code, invitation by token hash, own-membership reads. |
| 0004 | `work_management` | Tasks, assignees, dependencies, labels, comments, mentions, activity, attachments, outbox, triggers, `pg_trgm`. |
| 0005 | `work_management_rls` | RLS for the above; activity is append-only. |
| 0006 | `productivity` | Recurrence series, custom fields and values, saved views. |
| 0007 | `productivity_rls` | RLS for the above. |
| 0008 | `jobs_notifications_integrations` | Jobs, notifications, preferences, delivery attempts, digest log, Discord destinations, calendar connections and links, OAuth states. |
| 0009 | `jobs_notifications_integrations_rls` | `app_is_worker()`, RLS for the above, worker policies for jobs/outbox/organizations. |
| 0010 | `retention_indexes` | Indexes the retention job relies on. |
| 0011 | `retention_controls` | `purge_audit_logs()` (90-day floor), owner-bound audit policies, worker policy for purging the history of trashed tasks, expired OAuth states. |
| 0012 | `bootstrap_policy` | Owner-bound policies so bootstrap and system-role sync work for a plain owner. |
