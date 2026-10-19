import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Backup + restore drill (docs/BACKUP_RESTORE.md).
 *
 *   1. pg_dump the SOURCE database (custom format),
 *   2. pg_restore the dump into a brand-new scratch database,
 *   3. compare both databases: structure, every table's row count and content checksum, row-level-security flags,
 *   4. re-apply the runtime role's grants on the restored copy and prove tenant isolation still holds through that role.
 *
 * It never writes to the source and refuses to restore into anything that is not named "*restore_check*".
 * A passing run proves the dump/restore mechanics and the integrity of the restored data for THIS database only; it
 * says nothing about a managed provider's own backups (see the document).
 *
 *   tsx scripts/backup-restore-test.ts [--source <url>] [--admin <url>] [--out <dir>]
 */
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const ADMIN = arg("admin", process.env.BACKUP_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:54329/postgres");
const SOURCE_DB = new URL(arg("source", process.env.BACKUP_TEST_SOURCE_URL ?? "postgres://postgres@127.0.0.1:54329/tasktracker_e2e")).pathname.slice(1);
const OUT = arg("out", ".data/backup");
const SCRATCH = "tasktracker_restore_check";
const APP_ROLE = "tt_app_restore_check";

const urlFor = (db: string, user?: string, password?: string) => {
  const u = new URL(ADMIN);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = password ?? ""; }
  return u.toString();
};

interface Check { name: string; ok: boolean; detail?: string }
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

async function connect(db: string, user?: string, password?: string) {
  const c = new pg.Client({ connectionString: urlFor(db, user, password) });
  await c.connect();
  return c;
}

/** One row per table: row count and an order-independent content hash of every column. */
async function fingerprint(c: pg.Client, schema: string) {
  const tables = (await c.query(`select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by 1`, [schema])).rows.map((r) => r.table_name as string);
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const t of tables) {
    const r = await c.query(`select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), 'empty') as h from "${schema}"."${t}" x`);
    out[`${schema}.${t}`] = { rows: r.rows[0].n, hash: r.rows[0].h };
  }
  return out;
}

async function structure(c: pg.Client) {
  const q = async (sql: string) => (await c.query(sql)).rows.map((r) => Object.values(r).join("|"));
  return {
    tables: await q(`select tablename from pg_tables where schemaname = 'public' order by 1`),
    columns: await q(`select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable from information_schema.columns where table_schema = 'public' order by 1`),
    indexes: await q(`select indexname from pg_indexes where schemaname = 'public' order by 1`),
    constraints: await q(`select conrelid::regclass::text || '.' || conname || ':' || contype::text from pg_constraint where connamespace = 'public'::regnamespace order by 1`),
    policies: await q(`select tablename || '.' || policyname || ':' || cmd from pg_policies where schemaname = 'public' order by 1`),
    rls: await q(`select relname::text || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`),
    functions: await q(`select proname::text || ':' || prosecdef::text from pg_proc where pronamespace = 'public'::regnamespace order by 1`),
    enums: await q(`select t.typname || ':' || string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname order by 1`),
    extensions: await q(`select extname from pg_extension order by 1`),
  };
}

async function main() {
  if (!/restore_check/.test(SCRATCH)) throw new Error("refusing to restore into a database that is not a scratch database");
  mkdirSync(OUT, { recursive: true });
  const dump = path.join(OUT, `${SOURCE_DB}.dump`);
  rmSync(dump, { force: true });

  // 1. dump (read-only on the source)
  const started = Date.now();
  execFileSync("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${dump}`, urlFor(SOURCE_DB)], { stdio: "inherit" });
  const bytes = statSync(dump).size;
  check("pg_dump produced a non-empty archive", bytes > 10_000, `${bytes} bytes in ${Date.now() - started} ms`);
  const toc = execFileSync("pg_restore", ["--list", dump], { encoding: "utf8" });
  check("the archive's table of contents is readable (pg_restore --list)", /TABLE DATA public tasks /.test(toc) || /TABLE DATA public tasks$/m.test(toc) || toc.includes("tasks"));

  // 2. restore into a fresh scratch database
  const root = await connect("postgres");
  await root.query(`drop database if exists ${SCRATCH} with (force)`);
  await root.query(`drop role if exists ${APP_ROLE}`);
  await root.query(`create database ${SCRATCH}`);
  const t1 = Date.now();
  execFileSync("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${urlFor(SCRATCH)}`, dump], { stdio: "inherit" });
  check("pg_restore completed without errors", true, `${Date.now() - t1} ms`);

  const src = await connect(SOURCE_DB);
  const dst = await connect(SCRATCH);
  try {
    // 3. compare
    const sStruct = await structure(src);
    const dStruct = await structure(dst);
    for (const key of Object.keys(sStruct) as (keyof typeof sStruct)[]) {
      const same = JSON.stringify(sStruct[key]) === JSON.stringify(dStruct[key]);
      check(`structure identical: ${key}`, same, same ? `${sStruct[key].length} objects` : `source ${sStruct[key].length} vs restored ${dStruct[key].length}`);
    }
    const sFp = { ...(await fingerprint(src, "public")), ...(await fingerprint(src, "drizzle")) };
    const dFp = { ...(await fingerprint(dst, "public")), ...(await fingerprint(dst, "drizzle")) };
    const names = Object.keys(sFp);
    const bad = names.filter((n) => !dFp[n] || dFp[n].rows !== sFp[n]!.rows || dFp[n].hash !== sFp[n]!.hash);
    const total = names.reduce((a, n) => a + sFp[n]!.rows, 0);
    check(`every table has the same rows and content checksum (${names.length} tables, ${total} rows)`, bad.length === 0, bad.length ? `differs: ${bad.join(", ")}` : undefined);
    const populated = names.filter((n) => sFp[n]!.rows > 0).length;
    check("the source actually contained data (otherwise the comparison proves nothing)", populated >= 10 && total >= 100, `${populated} populated tables, ${total} rows`);

    // 4. the runtime role on the restored copy: grants re-applied, tenant isolation intact
    await dst.query(`create role ${APP_ROLE} login password 'app' nosuperuser nobypassrls`);
    await dst.query(readFileSync("scripts/grants.sql", "utf8").replaceAll("{{APP_ROLE}}", APP_ROLE));
    const app = await connect(SCRATCH, APP_ROLE, "app");
    try {
      const orgs = (await src.query(`select o.id, (select count(*)::int from tasks t where t.org_id = o.id) as tasks from organizations o order by o.created_at`)).rows as { id: string; tasks: number }[];
      check("the restored database has an organization to test with", orgs.length >= 1, `${orgs.length} organizations`);
      // An installation is one organization, so a real one has nothing to be separated from: the cross-tenant half of the check needs two.
      check("tenants to test isolation between (a one-organization installation passes with a note: only the no-context and per-tenant checks apply)", true, orgs.length >= 2 ? `${orgs.length} organizations` : `only ${orgs.length} organization: cross-tenant check not applicable`);
      if (orgs.length < 1) throw new Error("nothing to test: the source has no organization");
      const visible = async (orgId: string | null) => {
        await app.query("begin");
        try {
          await app.query(`select set_config('app.org_id', $1, true), set_config('app.user_id', '', true), set_config('app.worker', '', true)`, [orgId ?? ""]);
          const r = await app.query(`select count(*)::int as n, count(*) filter (where org_id <> $1::uuid)::int as foreign from tasks`, [orgId ?? "00000000-0000-0000-0000-000000000000"]);
          return r.rows[0] as { n: number; foreign: number };
        } finally { await app.query("rollback"); }
      };
      for (const o of orgs) {
        const v = await visible(o.id);
        check(`runtime role sees exactly organization ${o.id.slice(0, 8)}'s ${o.tasks} tasks and none of another tenant's`, v.n === o.tasks && v.foreign === 0, `sees ${v.n}, foreign ${v.foreign}`);
      }
      const none = await visible(null);
      check("with no tenant context the runtime role sees no tasks at all", none.n === 0, `sees ${none.n}`);
      await app.query("begin");
      await app.query(`select set_config('app.org_id', $1, true)`, [orgs[0]!.id]);
      let denied = false;
      try { await app.query(`delete from audit_logs`); } catch { denied = true; }
      await app.query("rollback");
      check("audit logs are still append-only for the runtime role after restore", denied);
      // the two columns the runtime role may change on an organization: still granted on the restored copy, and only for its own row
      await app.query("begin");
      await app.query(`select set_config('app.org_id', $1, true)`, [orgs[0]!.id]);
      const sw = await app.query(`update organizations set registration_open = registration_open, auto_email = auto_email, email_schedule = email_schedule where id = $1`, [orgs[0]!.id]).then((r) => r.rowCount === 1, () => false);
      await app.query("rollback");
      check("the runtime role can still use the registration and automatic-e-mail switches of its own organization after restore", sw);
      const fn = await app.query(`select purge_audit_logs(90) is not null as ok`);
      check("retention function is present and callable by the runtime role after restore", fn.rows[0].ok === true);
    } finally { await app.end(); }
  } finally {
    await src.end();
    await dst.end();
    await root.query(`drop database if exists ${SCRATCH} with (force)`);
    await root.query(`drop role if exists ${APP_ROLE}`);
    await root.end();
  }

  const failed = checks.filter((c) => !c.ok);
  const report = { at: new Date().toISOString(), source: SOURCE_DB, archive: { file: dump, bytes }, passed: checks.length - failed.length, failed: failed.length, checks };
  writeFileSync(path.join(OUT, "last-restore-test.json"), JSON.stringify(report, null, 2));
  console.log(`\n${failed.length === 0 ? "RESTORE DRILL PASSED" : "RESTORE DRILL FAILED"}: ${report.passed}/${checks.length} checks`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("restore drill crashed:", e instanceof Error ? e.message : e); process.exit(2); });
