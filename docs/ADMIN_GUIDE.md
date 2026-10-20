# Administrator guide

For people with the **orgadmin** role (all permissions) and managers (a subset — see [RBAC.md](RBAC.md)). The interface is in Thai by default; the language button in the header switches to English and is remembered on your profile.

## 1. Setting up an organization

1. **Operator:** create the organization and the first administrator’s invitation (once, from a trusted machine — see [DEPLOYMENT.md](DEPLOYMENT.md) §2):
   `pnpm bootstrap --name "Acme Co" --slug acme --admin-email admin@acme.example --app-url https://tasks.example.com`.
   The command prints a **one-time link, valid 7 days**, bound to that e-mail address. Send it to the administrator over a private channel.
2. The administrator **registers with exactly that e-mail address**, verifies it from the e-mail Resend sends, signs in, opens the link and presses **Accept invitation**. (Someone else cannot use the link; an expired or reused link is refused.)
3. Add a second administrator as soon as possible (Members → Invitations) so the organization never depends on one person. The system refuses to remove, suspend or demote the **last** administrator.

**One installation is one organization.** `pnpm bootstrap` refuses to create a second, differently named organization (running it again with the same `--slug` only issues a fresh invitation). The *first administrator* is the person invited by that command; they hold `orgadmin`, the role with every permission. There is deliberately **no “owner” above `orgadmin`**: every administrator can do everything the first one can, including inviting, demoting (never the last one) and deleting structure. Keep that role for people you would trust with the whole workspace. (`--allow-additional` exists for test fixtures that need several organizations; do not use it in production.)

The `--slug` (the *organization code*) is what people type on **Request access** when there is more than one organization. With exactly one, the **Request access** page does not ask for a code at all. It is not a secret; approval is what protects the organization.

### Opening and closing registration (Settings → General)

Administrators (`org.manage_settings`) have a switch, **Allow new people to sign up and ask to join**:

* **On (the default):** anyone who knows the address of the site can create an account and press **Request access**; you still approve every request, and until you do they can reach nothing.
* **Off:** nobody new can create an account or ask to join. The only exception is an e-mail address that holds a **valid, unused invitation** (so you can still invite someone with Members → Invitations while it is off). The sign-up page says so, the **Request access** page is disabled, and the server refuses the same requests if someone sends them directly. People who are already members, and anyone who already has an account, are not affected.

Each change is written to the audit log (`org.registration_open` / `org.registration_close`). A side effect to know about: while the switch is off, the sign-up page can only tell “invited” from “not invited”, so someone who tries addresses one by one could learn which addresses have a pending invitation (all sign-up attempts, from everybody together, are limited to 60 per hour while registration is closed; past that the answer is “too many requests” whether or not the address is invited, so addresses cannot be tried one by one, and someone hammering the page can make a person with an invitation wait until the next hour).

### Naming the system (Settings → General)

Administrators (`org.manage_settings`) can give the product their own name instead of “Task Tracker”: **Settings → General → Name of this system**. Leave it empty (or press **Use the default name**) to go back.

* **Where it shows:** the pages built on the sign-in layout (sign-in, sign-up, forgot-password, “Your organizations”, request access and invitations) and the page title in the browser tab (both follow the one-organization rule below), the label of the menu for screen readers (the heading at the top of the left bar stays the **organization's own name**; the name is not printed on the organization's own screens, apart from the calendar option under Settings → Integrations), the source label of calendar events created or updated from then on (never checked in a real Google Calendar), the issuer of a two-factor entry made from then on (never checked in a real authenticator app), and **every e-mail the organization sends**: the subject (“[Bluebird] …”), the header and the footer of the message, and the sender's display name (“Bluebird <no-reply@your-domain>”). The address an e-mail comes from does not change; that is `EMAIL_FROM` and its domain, set by whoever runs the server. The sender's display name follows the product name once a custom name is set; while the default name is in use, e-mails keep the name configured in `EMAIL_FROM`. **Never checked:** how Resend and mail programs display a Thai or other non-Latin sender name (Resend was never called); if it looks wrong, the subject and the message still carry the name, and going back to the default name restores the configured sender name.
* **Rules:** 1 to 40 characters in any language; letters, numbers, spaces and `. , & ' ( ) + : ! ? _ -`, starting with a letter or a number. Quotes, angle brackets, `@`, emoji and any other symbol not listed are refused, because the name ends up in an e-mail header and in the HTML of pages and messages; a line break or a run of spaces is turned into one space.
* **One organization or several:** this installation is meant to hold one organization, and then its name is the name of the whole system, including the pages before sign-in and the reset-password and verification e-mails. With several organizations the pages before sign-in, the title of the browser tab and the verification and password-reset e-mails (none of which belongs to an organization) show the default name; each organization's own name appears in the e-mails it sends, as the label of its menu for screen readers and in the calendar option.
* **Delay:** the page title and the pages before sign-in follow a change within about ten seconds (the server remembers the name that long); inside the signed-in screens (the menu's label for screen readers, the calendar option) the name follows at once for the administrator who changed it and within five minutes for the others; an e-mail uses the name as it is at the moment it is sent; a tab that is already open keeps its name until it is reloaded. E-mails already sent keep the old name.
* Each change is written to the audit log (`org.app_name_change`, with the old and the new name).

## 2. Structure: departments, teams, projects (Structure)

* **Departments** group teams; **teams** belong to one department; **projects** are the container for tasks.
* A project can have **participating teams** (Structure → *Participating teams*). A person whose role is scoped to a team can see and work on the tasks of every project that team participates in.
* Only administrators manage departments and teams; managers can create projects.
* **Deleting (administrators only).** Each department, team and project has a **Delete** button on this page, after a dialog that says what goes with it and asks you to **type the name** of the thing (the button stays disabled until it matches exactly, spaces at the ends ignored, capital letters counted). **The server asks for the name too:** a request to delete one of them that does not carry the exact name is refused with “the name you typed does not match” (422) and nothing is deleted, so a script or a mis-aimed API call cannot delete by accident. The server also checks the permission again, before it looks at the name.
  * **A team:** the people who only had a role in that team lose that access (they stay members, with their other roles), the team leaves its projects, Discord channels and team-shared views of the team are removed. Projects and tasks are untouched.
  * **A department:** the same, for the department and **all teams in it**. Projects and tasks are untouched.
  * **A project:** the project **and all its tasks** are removed from every view straight away; its recurring tasks stop and its Discord channels are destroyed. The tasks are kept out of sight for 30 days and then erased for good ([RETENTION.md](RETENTION.md)); they **cannot be restored from the interface**, so treat this as final.
  * Every access a deletion takes away is written to the audit log as one `role.unassign` entry per person and role (with `via` = `team.delete` / `department.delete` / `project.delete`), and the deletion's own entry carries the counts (roles removed, project links, views, Discord channels, tasks, recurring series).
  * The rows are only marked as deleted (so history that mentions them still reads), and each deletion is in the audit log (`team.delete`, `department.delete`, `project.delete`). There is no “undo”; to bring a structure back, create it again.

* **The same typed-name dialog guards the other deletions that cannot be undone from the screen:** a custom role (type its name), a Discord destination (its name), archiving a custom field (its name), a recurring series (its title), cancelling an invitation (the invited e-mail address), revoking a member (their e-mail address) and deleting an attachment (its file name). These are asked in the browser; the server checks only the permission for them. Not asked this way, on purpose: deleting a task (it has the Undo bar and 30 days in the trash; a plain confirmation), removing a comment, a saved view or a dependency (small and recoverable), suspending a member (reversible with one click), and signing out other sessions.
* **Upgrading from a version before registration switch / deleting existed:** the permissions `department.manage`, `team.manage` and `project.delete` used to allow only creating departments and teams (and nothing for `project.delete`). They now also allow deleting. If you made custom roles that hold them (Members → Roles lists each role's permissions), check that you still want those people to be able to delete structure.

## 3. People (Members)

**Joining**

* **By invitation** (Members → Invitations): enter an e-mail address and a role. The person registers with that address and accepts the link.
* **By request** (only while registration is on, see above): a person registers, opens **Request access** (entering the organization code only if there is more than one organization), and waits. The same message is shown whether or not the code exists. They appear under **Waiting for approval**: pick a role and press **Approve** (or leave them pending). Until approval they can reach **nothing** in the organization; the server answers “not found”.

**Roles and scopes**

* Roles are bundles of permissions: `orgadmin`, `manager`, `member`, `viewer`, plus any **custom roles** you create (Members → Roles → *New role*, choose permissions).
* A role is assigned **within a scope**: the whole organization, one department, one team, or one project (Members → *Assign role*). The same person can be a manager in one team and a viewer in a project.
  Effective rights are the **union** of all assignments; there is no “deny”. Remove an assignment to take rights away.
* You cannot grant a role containing permissions you do not hold yourself.

**Suspending and removing**

* **Suspend** blocks all access immediately (checked on every request) and keeps their history; **Reactivate** restores it. **Revoke** ends the membership.
* A member with no role assignment can sign in but sees nothing (“deny by default”).

**When someone leaves or asks to be erased**

* People can erase their own account (Security page). Their name then reads **“Deleted user”** on the tasks, comments and attachments they leave behind, and tasks assigned to them become **unassigned** — check the board for work that needs a new owner.
* An account that is the **only administrator** of your organization cannot erase itself while other members exist: make someone else an administrator first (Members → *Assign role*).
* A person who is the only member of an organization can erase themselves only after confirming that the organization is left without members; it then stays in the database until an operator deletes it.
* You can **Revoke** a membership without the person erasing anything. If someone asks to be erased or to receive their data but cannot sign in, the operator runs `pnpm privacy export --email …` / `pnpm privacy erase --email … --yes` ([RETENTION.md](RETENTION.md#account-erasure)) after verifying who is asking.

**Formatting in comments and descriptions.** People can use Markdown: `**bold**`, `*italic*`, `` `code` ``, `- lists`, `> quotes` and `[text](https://link)`. Links open in a new tab; a link whose visible address differs from where it goes is annotated with the real host. HTML is shown as typed (never run), images are not embedded, and headings are drawn as bold text. Plain text typed before this feature looks the same unless it contained Markdown characters such as `*text*` or a line starting with `- `.

**Seeing other people's changes.** Open pages ask a cheap endpoint every ≈ 8 s whether anything they may see has changed and refresh only then (changes appear within roughly 10–20 s). It is not instant push; members, structure and settings pages refresh on their own timers or when you return to the tab.

## 4. Day-to-day task rules (what people will ask you)

* Statuses: To do, In progress, In review, Done, Cancelled, Blocked. Only valid moves are offered; leaving **Done/Cancelled** needs the *reopen* permission (managers and administrators). Details: [WORKFLOW.md](WORKFLOW.md).
* A task cannot start or finish while a **prerequisite** is not Done; a parent cannot be Done while a subtask is open.
* Deleting a task moves it (and its subtasks) to the **trash for 30 days**; any manager/administrator who can delete it can restore it from the “Undo” bar right after, or through the API later. After 30 days it is gone permanently ([RETENTION.md](RETENTION.md)).
* **Recurring tasks** (Recurring tasks, in the menu for managers and administrators): daily, weekly (chosen weekdays) or monthly (day of month, clamped to month end); tasks are created for the next 30 days and topped up hourly. Editing a schedule changes only **future, still-to-do** occurrences; started, finished and past ones are never touched.
* **Custom fields** (Settings → Custom fields): text, number (with optional min/max), date, dropdown, checkbox. Dropdown options can be renamed or archived but never removed, so stored values stay meaningful.
* **Saved views**: personal, team or organization-wide (organization-wide needs `view.share_org`). Results are always computed for the person opening the view — a shared view never shows someone data they cannot already see.

## 5. Notifications and integrations (Settings)

* **Personal notification settings:** per event and channel (in-app, e-mail), daily/weekly digest, quiet hours — evaluated in the person’s own time zone. E-mail defaults to assignments, mentions and due/overdue only.
* **Sending e-mails** (administrators, Settings → Notifications): three modes. **Off** (the default): e-mails wait until you press **Send waiting e-mails now** (recent ones only: 7 days, 500 a press); no digests. **On, once a day at 23:00 Thai time**: e-mails created during the day are held and go out in the 23:00 run (or the next time anybody uses the app after 23:00); anything created between 23:00 and 04:00 goes out at once. Deadline e-mails and digests are produced only between 23:00 and 03:59 Thai time, so a daily run that happens after 04:00 skips that day's. This mode is for hosting that can run the background work only once a day; Vercel Hobby is believed to be one, which was not confirmed (see [DEPLOYMENT.md](DEPLOYMENT.md) §0). **On, right away**: as soon as the background work runs (for a server that runs it every minute or every second). Whatever the mode, the bell inside the app always works, and the button queues the waiting and the held e-mails now (at most 500 waiting ones a press, from the last 7 days). Each is still sent under the normal rules, so a person's quiet hours and the e-mail limits can delay it, and an e-mail that is already being retried keeps its own schedule. The same button also sends that day's **deadline e-mail**: one e-mail per person listing their unfinished tasks that are overdue, due today or due tomorrow (at most 30 shown), and nothing for someone who has none.
* **Discord** (administrators): Settings → Discord → add a webhook URL for **one team or one project**, choose events. The URL is stored encrypted and is never shown again (only a short hint). By default messages are generic (“a task was updated”);
  turning on *include task titles* sends titles to Discord — a privacy decision, shown with a warning. Messages never mention `@everyone`/roles. After repeated failures or when Discord says the webhook is gone, the destination **disables itself** and says why; fix the webhook, then use **Rotate** or re-enable.
* **Google Calendar** (each person, Settings → Calendar): connect with Google; tasks assigned to you that have dates appear in your calendar. It is **one-way**: edits made in Google do not change tasks, and a task has exactly one event that moves with it. Disconnect removes the link and (if ticked) the events. If the connection shows an error, press *Connect* again.
* **Background jobs** (Settings → Integrations, people who manage integrations): counts of pending/dead jobs per kind and the last error class. Dead jobs usually mean a revoked credential or a removed webhook.

## 6. Audit log

Audit log (administrators): who did what and when — sign-ins, role and membership changes, invitations, structure changes, task create/update/status/assign/delete/restore, bulk changes, integration and security-relevant settings. **Kept for 90 days**, cannot be edited or deleted by anyone in the application, and never contains passwords, tokens, webhook URLs or message text. Filter by action prefix (for example `membership.`).

## 7. Routine operator tasks

| Frequency | Task | Command / place |
|---|---|---|
| After each release | Migrate, then grants, then deploy | [DEPLOYMENT.md](DEPLOYMENT.md) §6 |
| After each deploy | Smoke test | `pnpm smoke` |
| Daily | Backup (and copy it off-platform) | `scripts/backup.sh` — [BACKUP_RESTORE.md](BACKUP_RESTORE.md) |
| Monthly | Restore drill on a scratch database; review dead jobs; `pnpm audit --prod` | [BACKUP_RESTORE.md](BACKUP_RESTORE.md) §5 |
| After every restore | Re-run erasures made since the backup | [RETENTION.md](RETENTION.md#account-erasure) |
| On suspicion (not as routine) | Rotate secrets. `APP_ENCRYPTION_KEY`: `pnpm rotate:key`. `BETTER_AUTH_SECRET` also breaks every two-factor enrolment: follow with `pnpm auth:reset-2fa --all --yes` | [SECURITY.md](SECURITY.md) §2.6, §6 · [ENVIRONMENT.md](ENVIRONMENT.md) |
| Continuous | Uptime monitor on `/api/health/ready` | [DEPLOYMENT.md](DEPLOYMENT.md) §9 |

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nobody receives notification e-mail | First check **Settings → Notifications → Sending e-mails**: with **Send notification e-mails automatically** off (the default) nothing is sent by itself, so Background jobs shows no pending job; press **Send waiting e-mails now** or switch it on. With **Once a day at 23:00 Thai time** chosen, e-mails created during the day wait for the 23:00 run. Then: Resend domain not verified / `RESEND_API_KEY` wrong / the background work is not running (with the switch on, Background jobs shows pending `notification.email`). Account e-mails (verification, password reset, invitations) are sent at once whatever the switch says. |
| Notifications arrive late | Cron cadence is slower than every minute (for example a plan that allows only a daily cron; Vercel Hobby is believed to, not confirmed), or the schedule is “once a day” — see [DEPLOYMENT.md](DEPLOYMENT.md) §0 and [DEPLOYMENT_TH.md](DEPLOYMENT_TH.md) step 7.4. |
| “Request access” always says sent but nothing appears | The organization code is wrong (by design the answer is identical); or the person has not verified their e-mail. |
| “New sign-ups are closed at the moment” | An administrator switched registration off (Settings → General). Invite the person (Members → Invitations) or switch it back on. |
| `pnpm bootstrap` says the installation already has an organization | By design (one installation, one organization). Use the existing `--slug` to issue a new invitation for the same organization. |
| A person sees an empty workspace | Approved but no role assignment — assign one. |
| A task “disappeared” | Deleted within 30 days: undo/restore it; otherwise it was purged. |
| Calendar connection shows an error | The Google grant was revoked or expired — reconnect. |
| Everything returns 503 “Service unavailable” | The database role bypasses row-level security (the app refuses to serve). Run `pnpm verify:database`. |
