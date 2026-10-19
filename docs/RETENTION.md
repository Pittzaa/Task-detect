# Retention, deletion and purge policy

One source of truth in code: `src/domain/retention.ts`. The job is `retention.purge` (`src/jobs/handlers/retention.ts`), scheduled **once a day** by the
cron tick; `storage.orphans` runs **weekly**. Both are idempotent, bounded in time (≈ 40 s per run; if work remains the job defers itself by a minute
without using a retry), and safe to run concurrently or twice.

## Policy

| Data | Kept for | Then | Who can remove it earlier |
|---|---|---|---|
| **Audit log** | **90 days** (product requirement) | Deleted by the database function `purge_audit_logs()` | **Nobody through the application.** No application role, including organization administrators, can edit or delete audit rows. An operator with the owner/superuser database role can (for example `pnpm org import --replace` rewrites an organization's rows). |
| Tasks (**soft-deleted**), incl. subtasks, comments, mentions, labels, assignees, dependencies, custom-field values, activity history, attachments, notifications about them | **30 days** in the trash | Permanently deleted, files included | Restore: anyone holding `task.delete` for that task (`orgadmin`, `manager`) within 30 days. Permanent delete: only this job. |
| Removed **attachments** (soft-deleted individually) | 30 days | Row and file deleted | Same as above (an administrator can restore via the database only; there is no UI for attachment restore). |
| Soft-deleted saved views | 30 days | Deleted | — |
| Finished background jobs | 7 days (`succeeded`) · **30 days** (`dead`, kept for investigation) | Deleted | — |
| Processed outbox events | 7 days | Deleted | — |
| In-app notifications | 90 days | Deleted | — |
| E-mail/Discord delivery attempts | 30 days | Deleted | — |
| Digest de-duplication log | 35 days | Deleted | — |
| Expired sessions, verification tokens, OAuth states, rate-limit counters | 1 day after expiry | Deleted | — |
| Orphaned files (in Blob, no database row) | 24 h grace | Deleted by the weekly sweep | — |
| Users | Until the person erases their account (Security page → *Erase my account*) | The profile row stays as a **placeholder** (name “Deleted user”, address `erased-<id>@erased.invalid`) so the organization's records keep their references; everything personal is removed — see [Account erasure](#account-erasure) | The person, with their password |
| Personal-data export (`/api/me/export`) | — | Contains a person's own work only in projects that still exist: work in a **deleted** project is left out for everyone, administrators included, and counted in `tasksNotShown`, although its rows stay in the database until the 30-day trash purge. | — |
| Organizations, roles | Not purged | Soft-delete/suspension only | An operator (no UI for deleting an organization) |
| Departments, teams, projects (**soft-deleted** by an administrator) | Rows are kept (so history that mentions them still reads); not purged | — | A deleted **project** takes its tasks with it: they enter the task trash above and are erased after 30 days, and cannot be restored from the interface. Its recurring series stop, its Discord destinations are destroyed (secret erased at once), and team/department/project-scoped role assignments, the teams' project links and team-shared views are removed. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) §2. |

“Kept for” means *at least*: the daily job removes data on its next run after the period ends. Pending (unprocessed) jobs and outbox events are **never** purged.

## What “soft delete” hides

A soft-deleted task is excluded from lists, boards, calendars, timelines, dashboard counts, search, saved views, notifications, Discord and calendar sync (the
calendar event is removed), and from dependency gating (a deleted prerequisite no longer blocks). Subtasks go with their parent and come back with it.
Deleted rows are visible only through `restore` by a permitted user. These properties are covered by tests (`tests/integration/tasks.test.ts`, `productivity.test.ts`, `calendar.test.ts`).

## How a task is purged (`purgeOrganization`)

Per organization, in its own tenant context (the organization id always comes from a database row, never from input), in leaf-first waves of ≤ 100 tasks:

1. Select trashed tasks older than 30 days that have **no child rows at all** and **no calendar link** (`FOR UPDATE SKIP LOCKED`).
   * A trashed parent with a subtask that has been brought back to life waits (nothing live is ever orphaned).
   * A task still linked to a Google event waits until calendar cleanup removes the event, so no event is left behind. The count of waiting tasks is logged
     (`skippedWithCalendarLinks`); a permanently failing calendar connection therefore keeps its tasks in the trash and shows up in the logs.
2. Delete, in one transaction: comment mentions → comments → labels → assignees → dependency edges (both directions, so a live task that depended on it is unblocked) → custom-field values → attachments → activity history → notifications about it → the task.
   The activity table is append-only for tenants; the policy `activity_purge` lets the worker delete history **only of tasks that are already in the trash**.
3. **After the commit**, delete the files. The database is the source of truth: if file deletion fails, the object becomes an orphan and the weekly sweep removes it. A failure can never lose or resurrect data.
4. One audit entry per organization per run (`retention.purge`) records **counts only** (`tasks`, `attachments`, `notifications`, `other`), never titles or contents.

A task restored by a user between selection and deletion is safe: rows are locked when selected and the delete also requires `deleted_at IS NOT NULL`.

## Audit logs: how the 90 days are enforced

* The runtime role has **no** `UPDATE`/`DELETE`/`TRUNCATE` grant on `audit_logs` and no RLS policy for them (verified by `tests/integration/tenant-isolation.test.ts`, `retention.test.ts` and `pnpm verify:database`).
* Purging goes through `purge_audit_logs(days)`, a `SECURITY DEFINER` function owned by the migration owner with `search_path` pinned. It computes `now() - greatest(days, 90)`,
  so **calling it with `1` still keeps everything younger than 90 days** (tested). A compromised application therefore cannot erase recent history.
* The owner is itself subject to forced RLS unless it has `BYPASSRLS`, so two owner-bound policies (`audit_retention_select`, `audit_retention`, limited to rows older than 90 days) make the function work for a plain owner. This was
  found and fixed by `tests/integration/owner-role.test.ts`, which builds a database owned by a plain role and checks both the success path and that dropping the policies would delete nothing.
* **What is audited:** sign-ins, authorization denials, membership and role changes, invitations, organization/department/team/project administration, task create/update/status/assign/dependency/delete/restore, bulk updates, comments deleted,
  attachments uploaded/removed, series changes, custom-field changes, saved-view changes, integration configuration (create/update/rotate/delete), calendar connect/disconnect, retention runs.
* **What is recorded:** actor, organization, action, target type/id, timestamp and a small metadata object of counts and identifiers (e.g. `{from, to}` for a status change). **Never** passwords, session tokens, OAuth tokens, API keys, webhook URLs or message bodies;
  task titles and comment text are not copied into the audit log. Application logs are redacted by key (`src/lib/logger.ts`).
* Read access: `org.read_audit_log` (organization administrators), scoped to their own organization.

## Running and observing it

```bash
# one-off (also what the cron does daily)
curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/tick
```

The structured log line `retention purge finished` carries the counters (`auditLogs`, `jobs`, `outbox`, `authRows`, `tasks`, `attachments`, `objects`, `objectFailures`, `notifications`, `other`, `skippedWithCalendarLinks`, `more`).
`objectFailures > 0` means files will be retried by the orphan sweep; `more: true` means the run hit its time budget and re-queued itself.

## Changing the policy

Edit `src/domain/retention.ts` (the audit value cannot go below 90 in the database regardless) and this document together. Shortening a period deletes data on the next run; lengthening it
only stops further deletion. There is no per-organization override.

## Verified by

`tests/integration/retention.test.ts` (10 tests), `tests/integration/owner-role.test.ts`, `tests/integration/verify-attachments.test.ts`, `tests/unit/schema-version.test.ts`. Mutation checks performed manually: lowering the SQL floor from 90 to 1 fails the floor test; removing the
“no child rows” guard makes the purge abort for the organization and fails two tests.

## Account erasure

`DELETE /api/me` (Security page → *Erase my account*) implements a data-subject deletion request. It needs the typed e-mail address **and** the password (an account with no password,
for example Google-only, needs a sign-in from the last 15 minutes). It is one database transaction, rate limited to 6 attempts per hour, and writes an `account.erased` audit entry in every organization the person belonged to.

| Removed | Kept |
|---|---|
| Name, e-mail address, image (replaced by “Deleted user”), verification state, two-factor flag | Tasks, comments, attachments and their activity history the person created — they are the **organization's records** (retention rules above still apply to them) |
| Password, social-login links, sessions on every device, two-factor secret and backup codes, pending OAuth states, e-mail verification tokens | Audit entries about the person's actions (90-day rule; the actor now reads “Deleted user”) |
| Role assignments, assignee links (tasks assigned to them become unassigned), notifications, notification settings and preferences, digest log, saved views | The membership row, marked `revoked` (foreign keys depend on it) |
| Google Calendar link: the cleanup job deletes the events we created in their calendar and revokes the token | |

**Refused (nothing changes):** a wrong e-mail/password; a platform administrator; the only administrator of an organization that still has other members (promote someone first). If the person is the only member of an organization the request needs an explicit “leave it without anyone” confirmation, and the organization then stays in the database with no members until an operator deletes it.

**Operators** (the person cannot sign in): `DATABASE_URL=<runtime role> pnpm privacy export --email a@b.c [--out file.json]` and `pnpm privacy erase --email a@b.c [--abandon] --yes`. The same refusals apply (sole administrator, platform administrator); the operator is trusted to have verified the requester's identity. Smoke-tested against the end-to-end database with the least-privilege role.

Not erased automatically: free text the person wrote that names *other* people or themselves inside tasks and comments (it belongs to the organization; an administrator can trash the task); backups (they age out according to your backup retention — erasure is not re-applied to old dumps, so a **restore must re-run the erasure**, see [BACKUP_RESTORE.md](BACKUP_RESTORE.md)).

## Data export (access request)

`GET /api/me/export` (Security page → *Download my data*) returns a JSON file: profile, sign-in history (IP address, device), memberships, and for each organization the tasks created by or assigned to the person that they can still open, their comments, attachment records (names and sizes, not the files), activity and audit entries about their own actions, notifications, settings, saved views and calendar link state. It never contains credentials. Work the person can no longer open (for example after losing access to a project) is **counted, not listed**. At most 5 000 rows per list (`truncated: true` says so); rate limited to 5 per hour.
