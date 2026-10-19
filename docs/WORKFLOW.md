# Task workflow rules

Authoritative code: `src/domain/workflow.ts`, `src/domain/graph.ts`, `src/data/tasks.ts`, `src/data/bulk.ts`, `src/data/timeline.ts`, `src/domain/recurrence.ts`. The server enforces every rule below; the UI only hides what would be refused.

## Statuses and transitions

Six stored values (language-independent identifiers): `todo`, `progress`, `review`, `done`, `cancelled`, `blocked`. Priorities: `low`, `medium`, `high`, `urgent`.

| From | Allowed moves |
|---|---|
| `todo` | `progress`, `blocked`, `cancelled` (**not** `done` directly) |
| `progress` | `review`, `done`, `blocked`, `todo`, `cancelled` |
| `review` | `done`, `progress`, `blocked`, `cancelled` |
| `blocked` | `todo`, `progress`, `cancelled` |
| `done` | `progress`, `todo` — **reopen**, needs `task.reopen` |
| `cancelled` | `todo` — **reopen**, needs `task.reopen` |

Anything else is rejected (`val.status_transition`). Changing status needs `task.change_status`; `completedAt` is set when entering `done` and cleared on leaving it (a database CHECK keeps `status = 'done'` and `completed_at` consistent).

## Dependencies

* A task may depend on any number of other tasks of the same organization (`Depends on` / `Blocks`). Cycles — including self-dependency — are rejected inside the same transaction with a lock, so concurrent edits cannot create one.
* **Starting or finishing** (`progress`, `review`, `done`) requires every live prerequisite to be `done`. `cancelled` does **not** satisfy a dependency; a **deleted** prerequisite no longer blocks. Moving to `todo`, `blocked` or `cancelled` is never gated.
* A person who cannot read a prerequisite sees a locked placeholder, never its title; edges returned by the timeline include only tasks present in the result set.
* Notifications are sent to the dependents’ assignees when a prerequisite changes status.

## Subtasks

* Up to 5 levels deep. A parent cannot become `done` while any subtask is not `done`/`cancelled` (`val.parent_incomplete`).
* Deleting a parent soft-deletes its subtasks with it (same timestamp); restoring the parent restores only the subtasks deleted with it. A subtask cannot be restored while its parent is in the trash.
* A task cannot be re-parented under its own descendant.

## Assignment

One primary assignee plus up to 20 co-assignees, all of whom must hold `task.read` for that project. People without `task.assign` may only assign **themselves** as primary. Changes notify the added and removed people.

## Concurrency

Every task has a `version`. Editing sends the version it was loaded with; a stale edit is rejected with `CONFLICT` (the UI says someone else changed the task). Status changes lock the row (`FOR UPDATE`). Bulk and series operations use row locks and unique constraints rather than read-then-write.

## Bulk actions

`POST /tasks/bulk` with one action — status, priority, assignee, due date — over up to **100** tasks (rate limited to 20 per 10 minutes per user).

* Each task is **authorized and validated independently** in its own savepoint; results are per task.
* Default policy: **partial success** — failures do not roll back the others. With `atomic: true`, any failure rolls everything back (HTTP 409, per-task results).
* Unreadable and nonexistent tasks both report `NOT_FOUND`, so the response leaks nothing. One audit entry summarizes the call (counts only).

## Views

* **List / Board / Calendar / Timeline / My tasks / Dashboard** all read through the same permission-aware query path (`listTasks`), so soft deletion and access are identical everywhere. Filters live in the URL, and saved views store the filter definition only.
* **Board:** one column per status. Dragging a card calls the same server-validated status endpoint as every other control; each card also has a status `select` so the board works by keyboard and touch.
* **Calendar:** weeks start on Monday; a task appears on every day of its start→due span, or on its single date. Tasks without any date are not shown.
* **Timeline (Gantt):** tasks with **neither** start nor due date are omitted (the page says so); a task with one date is a single-day bar; indentation shows nesting; dependency arrows are drawn only between tasks that are both in the visible window; zoom week/month; paging of the window by half a span.
* **My tasks:** your open work grouped Overdue / Today / This week / Later / No date, in **your** time zone.
* **Dashboard:** counts and trends computed from permitted tasks only; optionally per project.
* **Search:** substring/trigram search over titles and descriptions of permitted tasks, plus visible projects/teams/departments; snippets never include text from tasks the caller cannot read.

## Recurring tasks

* Rule: daily every *n* days; weekly every *n* weeks on chosen weekdays (Monday-based weeks anchored at the start date); monthly on a day-of-month, **clamped** to the month’s last day (31st → Feb 28/29). Optional end date and maximum count.
* Occurrences are ordinary tasks linked to the series by `(series_id, occurrence_date)` — a partial unique index makes generation idempotent and race-free. They are created up to **30 days ahead**, topped up hourly, and **never backfilled before today** (creating a series that starts in the past does not create past tasks).
* Editing: occurrences that are started, done, cancelled or in the past are **never modified or removed**. Future `todo` occurrences follow the series when you tick *also update open tasks in the future*, and are added/removed when the schedule itself changes. Pausing stops generation; resuming resumes from today. Deleting removes only open future occurrences.
* Dates are calendar dates, so DST never moves them; reminders are computed as 09:00 (or the user’s own preference) in the recipient’s IANA zone, bracketed across DST changes (tested for zones east and west of UTC and across transitions).

## Time zones

Each user has an IANA time zone (captured from the browser at registration, editable under Security → Profile). “Today”, overdue, reminders, digests and quiet hours all use the **viewing/receiving user’s** zone. Stored timestamps are UTC instants; due dates are zone-less calendar dates.

## Reminders and notifications

Per task: optional “remind N days before due” (0–30). Events: assigned, unassigned, commented, mentioned, status changed, priority changed, due soon, overdue, dependency changed. Channels: in-app (default on) and e-mail (default on only for assigned, mentioned, due soon, overdue). **Due soon and overdue are never e-mailed one task at a time:** the e-mail choice for them decides what goes into one **deadline e-mail a day** per person (`src/jobs/handlers/deadline.ts`) that lists their unfinished tasks that are overdue or due today or tomorrow in their own calendar (up to 30: today’s and tomorrow’s first, then the most recently overdue, with the number of the rest), with project, status, priority and due date, and nothing is sent to someone with no such task. Every e-mail the application sends is HTML with a plain-text twin. Whether notification e-mails go out by themselves (right away, or held for 23:00 Thai time) or when an administrator presses a button is an organization setting (see [ARCHITECTURE.md](ARCHITECTURE.md)). Duplicate prevention: every notification has a per-recipient dedupe key, so reprocessing an event never produces a second one. Push notifications are intentionally **not** implemented.
