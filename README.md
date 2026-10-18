# Task Tracker

A multi-tenant task tracker for organizations (departments → teams → projects → tasks) on **Next.js 16 / React 19 / TypeScript**, **Neon PostgreSQL**, **Vercel** and **Resend**.
Thai (default) and English. Strict tenant isolation (application scoping **and** PostgreSQL row-level security), scoped role-based access, workflow rules,
List / Board / Calendar / Timeline / Dashboard / My-tasks views, search, saved views, custom fields, bulk actions, recurring tasks, notifications (in-app, e-mail, Discord),
Google Calendar one-way sync, private attachments (up to 25 MB where Vercel Blob is configured), safe Markdown in comments and descriptions, 90-day audit log, durable background jobs, change-signal refresh, personal data export and account erasure, per-organization export/import, backups with a tested restore procedure, optional error reporting (Sentry protocol).

> **Status: release candidate, not yet deployed anywhere.** Everything was built and tested against a local PostgreSQL 16 and a local production build.
> Vercel, Neon, Resend, Google, Discord and Vercel Blob were **never contacted**. Read [docs/READINESS_REPORT.md](docs/READINESS_REPORT.md) (what was verified, what was not, go-live blockers)
> and [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) before launching.

## Prerequisites
* Node.js ≥ 22, pnpm 10
* PostgreSQL ≥ 14 (16 used for all tests); production target is Neon
* For browser tests: Chromium (Playwright is configured to use `/opt/pw-browsers/chromium`, override with `PLAYWRIGHT_CHROMIUM`)

## Run it locally
```bash
pnpm install
cp .env.example .env.local                 # fill DATABASE_URL, DATABASE_URL_UNPOOLED, BETTER_AUTH_SECRET, APP_ENCRYPTION_KEY (see docs/ENVIRONMENT.md)

# 1. schema (as the database OWNER), 2. least-privilege runtime role + grants, 3. first organization
DATABASE_URL_UNPOOLED=postgres://owner@localhost/tasks pnpm db:migrate
psql postgres://owner@localhost/tasks -c "CREATE ROLE tt_app LOGIN PASSWORD 'dev' NOSUPERUSER NOBYPASSRLS" \
     -c "$(sed 's/{{APP_ROLE}}/tt_app/g' scripts/grants.sql)"
DATABASE_URL_UNPOOLED=postgres://owner@localhost/tasks pnpm bootstrap --name "Acme" --slug acme --admin-email you@example.com
#   → prints a one-time invitation link for the first administrator

# DATABASE_URL in .env.local must use the tt_app role, otherwise row-level security does not apply to your session
pnpm dev                                    # http://localhost:3000   (e-mails are logged, attachments go to .data/uploads)
```

## Commands
| Command | Purpose |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm lint` / `pnpm typecheck` | static checks |
| `pnpm test:unit` | pure-logic tests |
| `pnpm test:integration` | real PostgreSQL, least-privilege role (needs `TEST_DATABASE_URL`) |
| `pnpm test:e2e` | build + Playwright browser tests (Chromium) |
| `pnpm test:e2e:browsers` | the same suite once per engine: Chromium, Firefox, WebKit (the last two need `playwright install`; **never run by the author**) |
| `pnpm load` | load test against a production build with seeded volume (`scripts/load-test.ts`; see [docs/TESTING.md](docs/TESTING.md)) |
| `pnpm db:generate` / `pnpm db:migrate` | create / apply migrations |
| `pnpm bootstrap` | create an organization + first-admin invitation (operator) |
| `pnpm verify:database` | prove the runtime role and policies on **your** database |
| `pnpm smoke` | post-deployment HTTP checks |
| `pnpm verify:attachments` | database ↔ object storage consistency |
| `pnpm backup:attachments --to …` / `--restore --from …` | copy attachment files to a second store / back (operator) |
| `pnpm backup:restore-test` / `scripts/backup.sh` | restore drill / logical backup |
| `pnpm rotate:key` | re-encrypt stored secrets after rotating `APP_ENCRYPTION_KEY` |
| `pnpm org export\|import` | one organization out of / into a database (partial restore, operator) |
| `pnpm privacy export\|erase --email …` | data-subject requests when the person cannot use the Security page (operator) |
| `pnpm docs:generate` / `pnpm docs:erd` | regenerate derived documentation |

## Repository layout
```
src/domain/       pure rules (workflow, graph, recurrence, time, notifications, files, retention)
src/authz/        permission catalog + evaluator
src/data/         tenant-scoped services (withTenant → TenantSession)
src/db/           Drizzle schema, client, RLS guard
src/integrations/ email (Resend), Discord, Google Calendar, object storage
src/jobs/         queue, worker, handlers, scheduler
src/ops/          operator tools (attachment verification, key rotation)
src/server/       HTTP plumbing (handle, auth, runtime, rate limits)
src/app/, src/ui/ pages and components
drizzle/          versioned SQL migrations        scripts/   operator CLIs
tests/            unit · integration · e2e        docs/      documentation
```

## Documentation
| Document | Contents |
|---|---|
| [READINESS_REPORT](docs/READINESS_REPORT.md) | Verified results, remaining risks, go-live blockers |
| [KNOWN_LIMITATIONS](docs/KNOWN_LIMITATIONS.md) | Deviations from the brief, unverified items, decisions left to the owner |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Layers, request lifecycle, jobs, decisions |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Vercel, Neon, Resend, Google, Blob; verification scripts; go-live checklist; rollback |
| [DEPLOYMENT_TH](docs/DEPLOYMENT_TH.md) | คู่มือ deploy ภาษาไทยทีละขั้น (Neon → Resend → Blob → Vercel → ตรวจสอบ → go-live) |
| [ENVIRONMENT](docs/ENVIRONMENT.md) | Every variable, where it is used, how to generate it |
| [SECURITY](docs/SECURITY.md) | Threat model, controls with evidence, findings, incident procedures |
| [RBAC](docs/RBAC.md) | Roles, scopes, evaluation rules, permission matrix (generated) |
| [WORKFLOW](docs/WORKFLOW.md) | Status transitions, dependencies, bulk, views, recurrence, time zones |
| [ERD](docs/ERD.md) | Generated entity-relationship diagram (42 tables) |
| [RETENTION](docs/RETENTION.md) | Deletion, purge and audit-retention policy |
| [BACKUP_RESTORE](docs/BACKUP_RESTORE.md) | Backup policy, restore procedure, recorded drill results |
| [MIGRATIONS](docs/MIGRATIONS.md) | Schema-change workflow, applied migrations |
| [TESTING](docs/TESTING.md) | Strategy, exact commands, what each suite proves |
| [ADMIN_GUIDE](docs/ADMIN_GUIDE.md) | Setting up and running an organization |
| [PROVIDERS](docs/PROVIDERS.md) | Why each provider, plan assumptions, alternatives |
| [PHASE0_PROPOSAL](docs/PHASE0_PROPOSAL.md) | The original technical proposal (historical, in Thai) |
