import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/migrate";
import { checkRlsEnforceable, createDb } from "@/db/client";

/**
 * A managed Postgres gives you an ordinary, non-superuser database owner, and the row-level-security guarantees must
 * hold for THAT owner too. This builds a throw-away database owned by a plain role (no SUPERUSER, no BYPASSRLS),
 * applies every migration as that role, applies the production grants, and checks the retention controls through the
 * least-privilege runtime role.
 *
 * It simulates the strictest owner a provider could hand out. It does NOT prove anything about a real Neon project.
 */
const SUPER = process.env.TEST_DATABASE_URL!;
const DB = "tasktracker_test_owner";
const OWNER = "tt_owner_plain";
const APP = "tt_app_owner_check";
const withDb = (user: string, password: string | null, db: string) => {
  const u = new URL(SUPER);
  u.pathname = `/${db}`;
  u.username = user;
  u.password = password ?? "";
  return u.toString();
};

let sup: pg.Client; // superuser, scratch database (fixtures only)

beforeAll(async () => {
  const root = new pg.Client({ connectionString: SUPER });
  await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`);
  await root.query(`drop role if exists ${APP}`);
  await root.query(`drop role if exists ${OWNER}`);
  await root.query(`create role ${OWNER} login password 'owner' nosuperuser nobypassrls`);
  await root.query(`create role ${APP} login password 'app' nosuperuser nobypassrls`);
  await root.query(`create database ${DB} owner ${OWNER}`);
  await root.end();

  await runMigrations(withDb(OWNER, "owner", DB)); // as the plain owner

  const asOwner = new pg.Client({ connectionString: withDb(OWNER, "owner", DB) });
  await asOwner.connect();
  await asOwner.query(readFileSync("scripts/grants.sql", "utf8").replaceAll("{{APP_ROLE}}", APP));
  await asOwner.end();

  sup = new pg.Client({ connectionString: withDb(new URL(SUPER).username, new URL(SUPER).password || null, DB) });
  await sup.connect();
});

afterAll(async () => {
  await sup?.end();
  const root = new pg.Client({ connectionString: SUPER });
  await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`);
  await root.query(`drop role if exists ${APP}`);
  await root.query(`drop role if exists ${OWNER}`);
  await root.end();
});

describe("a plain (non-superuser, non-BYPASSRLS) database owner", () => {
  it("can apply every migration, and the owner really is subject to row-level security", async () => {
    const r = await sup.query(`select rolsuper, rolbypassrls from pg_roles where rolname = $1`, [OWNER]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const t = await sup.query(`select count(*)::int as n from pg_policies where tablename = 'audit_logs'`);
    expect(t.rows[0].n).toBeGreaterThanOrEqual(3); // select, insert, retention
    const f = await sup.query(`select pg_get_userbyid(proowner) as owner from pg_proc where proname = 'purge_audit_logs'`);
    expect(f.rows[0].owner).toBe(OWNER);
  });

  it("the runtime role passes the RLS-enforceable check", async () => {
    const { db, close } = createDb(withDb(APP, "app", DB));
    try {
      expect(await checkRlsEnforceable(db)).toBeNull();
    } finally { await close(); }
  });

  it("purge_audit_logs works through the runtime role and respects the 90-day floor", async () => {
    const org = (await sup.query(`insert into organizations (name, slug) values ('O', 'o-owner-check') returning id`)).rows[0].id as string;
    await sup.query(
      `insert into audit_logs (org_id, action, created_at) values
        ($1, 'old', now() - interval '200 days'), ($1, 'edge-old', now() - interval '91 days'), ($1, 'edge-young', now() - interval '89 days'), ($1, 'new', now())`,
      [org],
    );
    const app = new pg.Client({ connectionString: withDb(APP, "app", DB) });
    await app.connect();
    try {
      const r = await app.query(`select purge_audit_logs(1) as n`);
      expect(Number(r.rows[0].n)).toBe(2);
      const left = await sup.query(`select action from audit_logs where org_id = $1 order by action`, [org]);
      expect(left.rows.map((x) => x.action)).toEqual(["edge-young", "new"]);
      // the runtime role itself still has no way to delete or update audit rows
      await expect(app.query(`delete from audit_logs`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`update audit_logs set action = 'x'`)).rejects.toThrow(/permission denied/);
    } finally { await app.end(); }
  });

  it("without the narrow owner policy the function would delete nothing (the policy is what lets a plain owner purge)", async () => {
    await sup.query(`drop policy audit_retention on audit_logs`);
    await sup.query(`drop policy audit_retention_select on audit_logs`);
    try {
      const org = (await sup.query(`select id from organizations where slug = 'o-owner-check'`)).rows[0].id as string;
      await sup.query(`insert into audit_logs (org_id, action, created_at) values ($1, 'old2', now() - interval '300 days')`, [org]);
      const app = new pg.Client({ connectionString: withDb(APP, "app", DB) });
      await app.connect();
      try {
        const r = await app.query(`select purge_audit_logs(90) as n`);
        expect(Number(r.rows[0].n)).toBe(0);
      } finally { await app.end(); }
    } finally {
      await sup.query(`create policy audit_retention_select on audit_logs for select to ${OWNER} using (created_at < now() - interval '90 days')`);
      await sup.query(`create policy audit_retention on audit_logs for delete to ${OWNER} using (created_at < now() - interval '90 days')`);
    }
  });
});
