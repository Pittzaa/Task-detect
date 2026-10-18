# Retention, deletion and purge policy

One source of truth in code: `src/domain/retention.ts`. The job is `retention.purge` (`src/jobs/handlers/retention.ts`), scheduled **once a day** by the
cron tick; `storage.orphans` runs **weekly**. Both are idempotent, bounded in time (≈ 40 s per run; if work remains the job defers itself by a minute
without using a retry), and safe to run concurrently or twice.

## Policy

| Data | Kept for | Then | Who can remove it earlier |
|---|---|---|---|
| **Audit log** | **90 days** (product requirement) | Deleted by the database function `purge_audit_logs()` | **Nobody.** No role, including the application and organization administrators, can edit or delete audit rows. |
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
| Users, organizations, projects, teams, departments, roles | Not purged | Soft-delete/suspension only | See limitations: there is no account-erasure tool. |

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
