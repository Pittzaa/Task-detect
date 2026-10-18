# Backup and restore

**Status: the restore procedure is proven on a local PostgreSQL 16. Your provider’s own backups (Neon) and your Blob store
are NOT proven.** A backup is only real once you have restored it. Do the drill in step 5 on your real plan before go-live.

## 1. What must be recoverable

| Data | Where it lives | Recovery source |
|---|---|---|
| All business data, users, sessions, roles, audit log, jobs | Neon PostgreSQL | Neon point-in-time restore / branch (plan-dependent **(verify)**) **and** a daily logical dump (`scripts/backup.sh`) |
| Attachment bytes | Vercel Blob (private) | **No backup mechanism is provided or verified.** See *Attachments* below. |
| Secrets (`APP_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, provider keys) | Vercel environment | Your password manager. **Without `APP_ENCRYPTION_KEY` stored Discord webhooks and Google refresh tokens cannot be decrypted** (re-enter / reconnect them; nothing else is lost). |
| Source code, migrations | Git | Git |

Recovery objectives are **targets you must set and then test**; none is promised by the software. A reasonable starting point:
RPO ≤ 24 h with the daily dump (≈ minutes if your Neon plan’s point-in-time restore covers it), RTO ≤ 2 h.

## 2. Backup

### 2.1 Provider-side (Neon) — verify, do not assume

The brief requires daily automated backups “using capabilities available on the selected Neon plan or a documented external process”,
and requires that plan limits are *verified rather than assumed*. The author could not read neon.com from the sandbox, so:

* **Check in the Neon console for your plan:** the history/restore window, whether branches can be created from a past timestamp,
  and the retention of that history. Write the numbers here: `window = ____ , plan = ____ , checked on ____ by ____`.
* Search results suggested that history retention is plan-dependent and short on free tiers; treat that as **unconfirmed**.

### 2.2 External logical dump (works on any plan)

`scripts/backup.sh` writes a `pg_dump` custom-format archive from the **direct** connection, optionally encrypts it
(AES-256-CBC, PBKDF2 600 000 iterations; passphrase from `BACKUP_PASSPHRASE`) and writes a SHA-256 file.

```bash
DATABASE_URL_UNPOOLED='<owner direct string>' BACKUP_PASSPHRASE='<passphrase>' scripts/backup.sh backups/
# → backups/taskdb-20261017T183929Z.dump.enc  + .sha256
```

Run it daily from somewhere that has `pg_dump` ≥ your server version (a scheduled CI job, a small VM). **Vercel functions cannot run it** (no
`pg_dump` binary), so the repository deliberately ships no scheduled workflow: a never-executed workflow would be false comfort.
An example GitHub Actions job is at the end of this file — **untested**.

* **The backup role must bypass row-level security.** Every tenant table has *forced* RLS, which binds even a table's owner. Verified locally: `pg_dump`
  run as a plain owner (no `SUPERUSER`, no `BYPASSRLS`) **fails** with `query would be affected by row-level security policy for table "attachments"`; the same owner
  with `BYPASSRLS` produces a complete archive. `scripts/backup.sh` checks this first and stops with an explanation (exit 3). Use a dedicated role
  (`CREATE ROLE tt_backup LOGIN PASSWORD '…' NOSUPERUSER BYPASSRLS; GRANT SELECT ON ALL TABLES IN SCHEMA public TO tt_backup;`), never the application’s runtime role, and keep its
  credentials out of Vercel. Whether Neon lets you create a `BYPASSRLS` role, and whether its default owner already has it, was **not verifiable** here — try it; if your plan
  forbids it, rely on Neon’s storage-level restore (which is not affected by RLS) and treat the logical dump as unavailable.
* **Scope:** the whole database (schema, data, RLS policies, functions). Roles and passwords are *not* in a dump (`--no-owner --no-privileges`);
  they are recreated in step 3 so the dump can be restored by any owner.
* **Encryption:** AES-256 with a passphrase kept **separately** from the archive. Verified here: encrypt → checksum → decrypt → `pg_restore --list` round trip, and a wrong passphrase fails (`bad decrypt`).
* **Access control:** the archive contains every tenant’s data, password hashes and (encrypted) integration secrets. Store it in a bucket only the backup operator can read; do not put it in the repository or in Vercel.
* **Retention:** keep at least 30 daily + 12 monthly archives, subject to your data-protection obligations (a restored archive resurrects deleted data — see [RETENTION.md](RETENTION.md)).

### 2.3 Attachments (not solved by this repository)

Vercel Blob is not backed up by anything here. Options, in increasing effort: (a) accept that attachment bytes are only as durable as Blob;
(b) periodically copy the store to a second bucket (a script using `ObjectStore.list/get` is straightforward but is **not written or tested**);
(c) keep Blob’s own versioning/replication if your plan offers it **(verify)**.
After *any* database restore run `pnpm verify:attachments` (read-only): it lists database rows whose file is missing, whose size differs, and (with `--hashes`)
whose SHA-256 differs, and counts files no row references. Files uploaded after the backup become unreferenced and are removed by the orphan sweep after 24 h.

## 3. Restore procedure (database)

Never restore over production first. Restore into a **new** database, verify, then switch traffic.

1. Create a fresh Neon branch/database (or a local scratch database).
2. If the archive is encrypted: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in X.dump.enc -out X.dump` and check `sha256sum -c X.dump.enc.sha256` first.
3. `pg_restore --no-owner --no-privileges --exit-on-error --dbname='<new owner direct string>' X.dump`
4. Recreate the runtime role if it does not exist, and apply grants: `psql … -c "$(sed 's/{{APP_ROLE}}/tt_app/g' scripts/grants.sql)"`.
5. `DATABASE_URL='<runtime string for the restored db>' pnpm verify:database` — must print `DATABASE CHECK PASSED`.
6. `pnpm verify:attachments` against the restored database and the live Blob store; investigate every `missing_object` finding.
7. Point a staging deployment at it, run `pnpm smoke`, sign in, open a few tasks.
8. Switch production: update `DATABASE_URL` / `DATABASE_URL_UNPOOLED` in Vercel and redeploy. Run `pnpm smoke` again.
9. Sessions in the dump are still valid for their original expiry; to force everyone to sign in again, rotate `BETTER_AUTH_SECRET`.
10. Record what happened (time of backup, time restored, data-loss window) for the post-incident review.

**Point-in-time restore on Neon** (if your plan offers it) follows the provider’s procedure (branch from a timestamp); steps 4–9 still apply to the new branch.

### Partial recovery (one organization or one task)

* **One task or a few:** soft-deleted tasks are restorable in-app by anyone with `task.delete` for **30 days** before the retention job removes them permanently.
* **One organization:** use the per-organization tool in [§6](#6-one-organization-export-import-and-partial-restore) — restore the full backup into a **scratch** database (steps 1–5), export the organization there, then import it into the live database.
* **After any restore, re-run erasures** that happened after the backup was taken (people who asked to be erased are otherwise back with their personal data): list them in the live database *before* restoring (`select id, email from users where deleted_at is not null`) and erase those accounts again in the restored one with `pnpm privacy erase`. See [RETENTION.md](RETENTION.md#account-erasure).

## 4. The restore drill (automated, local)

`pnpm backup:restore-test` (`scripts/backup-restore-test.ts`) performs steps 1, 3, 4 and part of 5 against a local cluster:

1. `pg_dump --format=custom` of a **source** database (default: the E2E database, which holds data produced by real browser sessions),
2. `pg_restore` into a brand-new scratch database,
3. compares source and restored databases: tables, columns, indexes, constraints, policies, row-level-security flags, functions, enums, extensions, **and for every table the row count and an order-independent MD5 of all columns**,
4. creates a fresh least-privilege role on the restored copy, applies `scripts/grants.sql`, and proves through that role that each tenant sees exactly its own rows, that no tenant context sees nothing, that audit logs are still append-only, and that the retention function works.

It refuses to restore into anything not named `*restore_check*`, never writes to the source, drops the scratch database afterwards, and writes `.data/backup/last-restore-test.json`.

### Result recorded for this release

Run on 2026-10-17 against the E2E database after a full 55-test browser run (13 migrations applied), PostgreSQL 16.15, local cluster:

```
PASS  pg_dump produced a non-empty archive  (170472 bytes in 113 ms)
PASS  pg_restore completed without errors  (512 ms)
PASS  structure identical: tables / columns / indexes / constraints / policies / rls / functions / enums / extensions
PASS  every table has the same rows and content checksum (43 tables, 390 rows)
PASS  the source actually contained data  (29 populated tables)
PASS  runtime role sees exactly each organization's own tasks and none of another tenant's
PASS  with no tenant context the runtime role sees no tasks at all
PASS  audit logs are still append-only for the runtime role after restore
PASS  retention function is present and callable by the runtime role after restore
RESTORE DRILL PASSED: 20/20 checks
```

**Sensitivity check:** with a deliberately corrupted restore (one task title altered and one policy dropped after `pg_restore`) the drill reported
`FAIL structure identical: policies (source 54 vs restored 53)`, `FAIL every table has the same rows and content checksum … differs: public.tasks` and `RESTORE DRILL FAILED: 18/20` — i.e. it does detect damage.

### What this does and does not prove

* ✅ The dump/restore **procedure** is correct and lossless for this schema, including row-level security, policies and functions, and the least-privilege role works on the restored copy.
* ✅ Encrypting and decrypting the archive works; a wrong passphrase is rejected.
* ❌ **Not proven:** that Neon’s automated backups / point-in-time restore exist on your plan, how long they are kept, or that they restore cleanly. Do step 5.
* ❌ **Not proven:** recovery of attachment bytes from Vercel Blob (no mechanism exists in this repository).
* ❌ Restoring from a *remote* archive over a network, at production data volumes, and the elapsed time (RTO) at that size. The drill used ≈ 170 KB.

## 5. Drill to run on your real plan before go-live

1. Take a dump with `scripts/backup.sh` from the real database (or create a Neon branch from a timestamp, if offered).
2. Restore it into a new, empty Neon database (steps 1–5 above).
3. Record: backup size, restore duration, the result of `pnpm verify:database`, and any difference. Paste the numbers into this file under *Result recorded for this release*.
4. Only then tick the “restore tested” box in [DEPLOYMENT.md](DEPLOYMENT.md).

## 6. One organization: export, import and partial restore

`pnpm org export` / `pnpm org import` (`scripts/org-transfer.ts`, `src/ops/org-transfer.ts`) move ONE organization between databases of the same application version.

```bash
# needs an OPERATOR role (superuser or BYPASSRLS — the same role pg_dump needs; the runtime role is refused)
export DATABASE_URL_UNPOOLED='postgres://backup_operator:…@…/db'
export ORG_EXPORT_PASSPHRASE='a long passphrase'          # optional but recommended: the file holds ALL of the organization's data
pnpm org export --org acme --out acme.org.gz              # organization code or UUID
pnpm org import --file acme.org.gz                        # DRY RUN: what would be created / replaced, row counts
pnpm org import --file acme.org.gz --apply                # into a database where the organization does not exist
pnpm org import --file acme.org.gz --apply --replace      # overwrite the existing organization with the bundle
```

**Partial restore of one organization after a mistake:** (1) restore last night's backup into a scratch database (steps 1–5 above); (2) `pnpm org export` from the scratch database; (3) `pnpm org import --replace` (dry run first, then `--apply`) into the live database. Everything of that organization that is **newer than the backup is lost**, and every other organization is untouched.

What the tool guarantees (all covered by `tests/integration/org-transfer.test.ts`, 18 tests, including four deliberate breakages that the tests caught):

* The bundle contains only rows of that organization, found by looking at the live schema (every table with an `org_id`), in foreign-key order; a new table is picked up automatically. Another tenant's rows, and users who only belong to other tenants, never appear.
* Import is **one transaction**: either every table is restored and the row counts verified, or nothing changes. The schema must match exactly (migration fingerprint) and the bundle's checksum must be intact.
* Users are created **without credentials** (no password, sessions or two-factor secret) and without the platform-administrator flag; users that already exist keep theirs. They regain access through the normal “Forgot password” e-mail (tested). An e-mail address that already belongs to a different account stops the import before anything is written.
* System roles are matched by key, because their ids differ between databases.

What it does **not** do:

* **Files.** Attachment *rows* are restored; the files in the object store are not part of the bundle (see [§2.3](#23-attachments-not-solved-by-this-repository) and `pnpm backup:attachments`).
* **Transient data:** background jobs, outbox, delivery attempts, digest log and OAuth states are not exported (they would replay old work). After an import give the job queue a few minutes; Google Calendar links come back with their encrypted tokens and are re-synced by the daily reconcile job. Encrypted secrets (Discord webhooks, calendar tokens) only decrypt with the **same `APP_ENCRYPTION_KEY`**.
* **Streaming.** The bundle is built in memory (gzip on disk). It is fine for tens of thousands of rows; for millions use a database-level restore instead.
* **Audit log immutability:** `--replace` deletes the organization's audit rows and re-inserts the bundle's (the operator role bypasses the append-only rule, by design, because it can already do anything). Keep operator credentials out of the application.

## Appendix — example scheduled backup (UNTESTED)

```yaml
# .github/workflows/backup.yml  — NOT in the repository on purpose; copy, review and test it yourself.
name: nightly-backup
on: { schedule: [{ cron: "17 2 * * *" }] }
jobs:
  dump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get install -y postgresql-client-16
      - run: scripts/backup.sh backups/
        env:
          DATABASE_URL_UNPOOLED: ${{ secrets.BACKUP_DATABASE_URL }}   # a dedicated BYPASSRLS backup role, see above
          BACKUP_PASSPHRASE: ${{ secrets.BACKUP_PASSPHRASE }}
      # upload backups/* to private storage here (not as a public workflow artifact)
```
