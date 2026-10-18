# Known limitations, deviations from the brief, and unresolved decisions

Honest list. “Deviation” = the brief asked for something this release does not do. “Risk” = works, but you should know. “Unverified” = built, but never exercised against the real service.

## Deviations from the brief

| # | Brief | What was built | Why / how to close it |
|---|---|---|---|
| 1 | Attachments up to **25 MB** | **4 MB** per file, 25 per task | Uploads pass through a Vercel function whose request body is reportedly capped near 4.5 MB (unverified). Direct-to-Blob client uploads (token endpoint + client SDK + completion callback) would lift it; not built. |
| 2 | Markdown in comments/descriptions | **Plain text only** (line breaks kept) | Removes an XSS class. A sanitized Markdown renderer can be added later. |
| 3 | Real-time updates | **Polling** (notifications 30 s, comments 20 s, lists 30–60 s, plus refetch on focus) | Serverless friendly. An SSE/WebSocket signal channel (e.g. Ably/Pusher) was not built. |
| 4 | Push notifications | Not implemented | Explicitly out of scope until later. |
| 5 | “superadmin” | A **flag only**; grants nothing in any organization | No cross-tenant operator console exists; operators use the scripts and the database. |
| 6 | Team/project “membership” tables | Modelled as **scoped role assignments** | One mechanism instead of three; semantics are in [RBAC.md](RBAC.md). A person “belongs to” a team by holding an assignment scoped to it. |
| 7 | Drag-and-drop everywhere | Board drag-and-drop plus a status `select` on every card/row | Keyboard/touch parity. No drag-to-reschedule on the calendar/timeline. |
| 8 | Daily automated database backups | A **verified procedure and script**, but no scheduler in the repository | Neon’s own backup features are plan-dependent and unverified; a scheduled job must be created by you ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)). |
| 9 | Backups of object storage | **Not provided** | See [BACKUP_RESTORE.md](BACKUP_RESTORE.md) §2.3. |

## Unverified against real services (never run)

Vercel (hosting, Cron, Blob), Neon (pooler behaviour, owner attributes, backup/PITR), Resend (delivery, domain verification, rate limits), Google (OAuth consent, Calendar API quotas), Discord (webhook rate limits). Fakes prove our handling of the documented shapes only.
Use `pnpm verify:database`, `pnpm smoke`, `pnpm verify:attachments` and the manual checklist in [DEPLOYMENT.md](DEPLOYMENT.md) §8.

## Risks and gaps

* **Single browser engine tested** (Chromium; desktop and 375 px). No Firefox/WebKit, no real devices, no screen-reader session. Automated accessibility checks (axe, WCAG 2.0/2.1 A/AA) pass on every page and dialog in light and dark themes, but they detect only part of the possible issues.
* **No load or performance testing.** Indexes exist for the main queries; list queries are paginated (50) and capped (100–500); but nothing was measured at volume. `listPeople` loads each candidate’s principal individually (≈ N queries for N members, capped at 500).
* **No error-tracking/APM provider.** Logs are structured JSON; alert on them yourself. No dead-man’s-switch if cron stops entirely (an external monitor on `/api/health/ready` covers it only if you set one up).
* **E-mail:** no bounce/complaint processing, no unsubscribe link (all mail is transactional or opt-in digests), plain-text/HTML templates are minimal.
* **No account-erasure or data-export tool** (GDPR/PDPA subject requests must be handled manually by an operator). Deleted users are flagged, not purged.
* **No per-tenant export/import**; partial recovery requires restoring a full dump to a scratch database ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
* **Retention:** a trashed task whose calendar event could not be removed stays in the trash (logged as `skippedWithCalendarLinks`) until the event is cleaned up. The orphan sweep lists a whole organization’s prefix in one go — fine for thousands of files, slow for millions.
* **Rate limits** are per user/key in the database (fixed window). There is no per-IP limit at the edge; put Vercel Firewall / Cloudflare rules in front of `/api/auth/*`.
* **Attachment content:** type is sniffed from bytes, but there is no malware scan and no preview/thumbnail generation.
* **Dependency advisory (accepted):** `braces` ≤ 3.0.3 via ESLint tooling, dev-only, no patched version published ([SECURITY.md](SECURITY.md) §3).
* **Concurrent role edits** are guarded by advisory locks for the last-administrator rule, but two administrators editing the same person’s roles at once get last-write-wins semantics on separate assignments.
* **Search** is substring/trigram, not linguistic: Thai word segmentation is not applied, so partial-word matches work but ranking is basic.
* **Calendar sync** is one-way and per user; shared/team calendars, attendee invitations and time-of-day events are not supported (all-day events from dates).
* **Time zones:** a user’s zone is set from the browser at registration; there is no automatic travel detection.
* `GET /api/cron/tick` runs the worker inside one function invocation (≤ 45 s). Very large backlogs drain over several ticks.

## Decisions left to the owner

1. Vercel plan: per-minute cron (Pro) vs. an external scheduler ([DEPLOYMENT.md](DEPLOYMENT.md) §0).
2. How and where to run the daily backup and the monthly restore drill, and whether to back up Blob.
3. Whether to build direct-to-Blob uploads to reach 25 MB.
4. A security contact address and an incident owner.
5. Whether Markdown, real-time push of changes, and SSO/SCIM are wanted in the next release.
6. Retention periods (30-day trash, 90-day notifications) — adjust `src/domain/retention.ts` if your policy differs.
