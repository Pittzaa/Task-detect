import pg from "pg";

/**
 * Deployment check for the DATABASE (docs/DEPLOYMENT.md). Run it ONCE per environment with the exact connection string
 * the application will use at runtime (DATABASE_URL, the least-privilege role), after migrations and grants:
 *
 *   DATABASE_URL=postgres://... pnpm verify:database
 *
 * It proves, against the real database you are about to serve traffic from, the properties the tenant-isolation design
 * depends on. It only READS (inside transactions that are rolled back) and changes nothing.
 */
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }

const results: { name: string; ok: boolean; detail?: string }[] = [];
const record = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

async function main() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const role = (await c.query(`select current_user as name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user`)).rows[0];
    record("runtime role is not a superuser", !role.rolsuper, role.name);
    record("runtime role does not bypass row-level security", !role.rolbypassrls);
    record("runtime role cannot create roles or databases", !role.rolcreaterole && !role.rolcreatedb);

    const tables = (await c.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`)).rows as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    const NO_RLS = new Set(["users", "auth_sessions", "auth_accounts", "auth_verifications", "auth_two_factor", "auth_rate_limits", "app_rate_limits"]);
    const unprotected = tables.filter((t) => !NO_RLS.has(t.relname) && !(t.relrowsecurity && t.relforcerowsecurity)).map((t) => t.relname);
    record(`every tenant table has FORCED row-level security (${tables.length - NO_RLS.size} checked)`, unprotected.length === 0, unprotected.join(", ") || undefined);

    // With no tenant context, tenant tables must look empty even if they contain data.
    await c.query("begin");
    const visible: Record<string, number> = {};
    for (const t of ["tasks", "comments", "attachments", "memberships", "role_assignments", "audit_logs", "notifications", "integration_destinations"]) {
      await c.query(`select set_config('app.org_id', '', true), set_config('app.user_id', '', true), set_config('app.worker', '', true)`);
      visible[t] = (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n;
    }
    await c.query("rollback");
    const leaks = Object.entries(visible).filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`);
    record("with no tenant context, tenant tables expose no rows", leaks.length === 0, leaks.join(", ") || undefined);

    // A made-up tenant must see nothing either.
    await c.query("begin");
    await c.query(`select set_config('app.org_id', '00000000-0000-4000-8000-000000000000', true), set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true)`);
    const ghost = (await c.query(`select (select count(*) from tasks)::int as t, (select count(*) from memberships)::int as m`)).rows[0];
    await c.query("rollback");
    record("an unknown tenant sees nothing", ghost.t === 0 && ghost.m === 0);

    // Audit logs are append-only for this role.
    for (const [name, stmt] of [["delete", "delete from audit_logs"], ["update", "update audit_logs set action = action"], ["truncate", "truncate audit_logs"]] as const) {
      await c.query("begin");
      let denied = false;
      try { await c.query(stmt); } catch { denied = true; }
      await c.query("rollback");
      record(`audit_logs ${name} is refused for the runtime role`, denied);
    }

    const fn = (await c.query(`select prosecdef from pg_proc where proname = 'purge_audit_logs' and pronamespace = 'public'::regnamespace`)).rows[0];
    record("retention function purge_audit_logs() exists and is SECURITY DEFINER", !!fn?.prosecdef);
    const exec = (await c.query(`select has_function_privilege(current_user, 'purge_audit_logs(integer)', 'execute') as ok`)).rows[0];
    record("runtime role may execute purge_audit_logs()", exec.ok === true);

    // Organizations are created by the operator only; the only things the runtime role may change are the registration and automatic-e-mail switches (and when they send).
    const orgPriv = (await c.query(`select has_table_privilege(current_user, 'organizations', 'insert') as ins, has_table_privilege(current_user, 'organizations', 'update') as upd, has_table_privilege(current_user, 'organizations', 'delete') as del, has_column_privilege(current_user, 'organizations', 'registration_open', 'update') as sw, has_column_privilege(current_user, 'organizations', 'auto_email', 'update') as ae, has_column_privilege(current_user, 'organizations', 'email_schedule', 'update') as es, has_column_privilege(current_user, 'organizations', 'app_name', 'update') as an, has_column_privilege(current_user, 'organizations', 'name', 'update') as name`)).rows[0];
    record("runtime role cannot create, rename or delete organizations", !orgPriv.ins && !orgPriv.upd && !orgPriv.del && !orgPriv.name);
    record("runtime role may change the registration and automatic-e-mail switches (re-run scripts/grants.sql if this fails)", orgPriv.sw === true && orgPriv.ae === true && orgPriv.es === true && orgPriv.an === true);

    const applied = (await c.query(`select count(*)::int as n from drizzle.__drizzle_migrations`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n as number;
    record("migrations table is readable (re-run scripts/grants.sql if this fails)", applied > 0, `${applied} applied`);
    const roles = (await c.query(`select count(*)::int as n from roles where org_id is null`)).rows[0].n as number;
    record("system roles are present (run `pnpm bootstrap` once if this fails)", roles >= 4, `${roles} system roles`);
  } finally {
    await c.end();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "DATABASE CHECK PASSED" : "DATABASE CHECK FAILED"}: ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("check crashed:", e instanceof Error ? e.message : e); process.exit(2); });
