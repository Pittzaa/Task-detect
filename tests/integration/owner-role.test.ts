import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/migrate";
import { checkRlsEnforceable, createDb } from "@/db/client";
import { bootstrapOrganization } from "@/data/bootstrap";

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

  it("the operator bootstrap works as that plain owner (row-level security applies to it too)", async () => {
    const { db, close } = createDb(withDb(OWNER, "owner", DB));
    try {
      const r = await bootstrapOrganization(db, { name: "Acme", slug: "acme-bootstrap", adminEmail: "Boss@Example.test", appUrl: "https://tasks.example.test" });
      expect(r.inviteUrl).toMatch(/^https:\/\/tasks\.example\.test\/invite\?token=/);
      const inv = await sup.query(`select email, accepted_at from invitations where org_id = $1`, [r.orgId]);
      expect(inv.rows).toEqual([{ email: "boss@example.test", accepted_at: null }]);
      const audit = await sup.query(`select action from audit_logs where org_id = $1`, [r.orgId]);
      expect(audit.rows.map((x) => x.action)).toContain("org.bootstrap");
      // running it again for the same slug reuses the organization and issues a fresh invitation
      const again = await bootstrapOrganization(db, { name: "Acme", slug: "acme-bootstrap", adminEmail: "boss@example.test", appUrl: "https://tasks.example.test" });
      expect(again.orgId).toBe(r.orgId);
    } finally { await close(); }
  });

  it("one installation is one organization: a second one is refused unless the operator insists", async () => {
    const { db, close } = createDb(withDb(OWNER, "owner", DB));
    try {
      await expect(bootstrapOrganization(db, { name: "Second", slug: "second-org", adminEmail: "other@example.test", appUrl: "https://tasks.example.test" })).rejects.toThrow(/already has an organization/);
      expect((await sup.query(`select count(*)::int as n from organizations where slug = 'second-org'`)).rows[0].n).toBe(0);
      const made = await bootstrapOrganization(db, { name: "Second", slug: "second-org", adminEmail: "other@example.test", appUrl: "https://tasks.example.test", allowAdditional: true });
      expect(made.orgId).toBeTruthy();
      expect((await sup.query(`select count(*)::int as n from organizations where slug = 'second-org'`)).rows[0].n).toBe(1);
    } finally { await close(); }
  });

  it("the runtime role can change an organization's registration switch (its own, nothing else about it)", async () => {
    const orgs = (await sup.query(`select id, slug from organizations where slug in ('acme-bootstrap', 'second-org') order by slug`)).rows as { id: string; slug: string }[];
    const acme = orgs.find((o) => o.slug === "acme-bootstrap")!;
    const second = orgs.find((o) => o.slug === "second-org")!;
    const app = new pg.Client({ connectionString: withDb(APP, "app", DB) });
    await app.connect();
    const inOrg = async (orgId: string, sql: string) => {
      await app.query("begin");
      await app.query(`select set_config('app.org_id', $1, true)`, [orgId]);
      try { return await app.query(sql); } finally { await app.query("rollback"); }
    };
    try {
      // own organization, the one allowed column
      expect((await inOrg(acme.id, `update organizations set registration_open = false where id = '${acme.id}'`)).rowCount).toBe(1);
      // another organization's row is invisible to the policy
      expect((await inOrg(acme.id, `update organizations set registration_open = false where id = '${second.id}'`)).rowCount).toBe(0);
      // no organization context at all
      expect((await inOrg("", `update organizations set registration_open = false where id = '${acme.id}'`)).rowCount).toBe(0);
      // every other column stays out of reach
      await expect(inOrg(acme.id, `update organizations set name = 'renamed' where id = '${acme.id}'`)).rejects.toThrow(/permission denied/);
      await expect(inOrg(acme.id, `update organizations set slug = 'renamed' where id = '${acme.id}'`)).rejects.toThrow(/permission denied/);
      await expect(inOrg(acme.id, `update organizations set deleted_at = now() where id = '${acme.id}'`)).rejects.toThrow(/permission denied/);
      // and the worker flag does not widen it
      await app.query("begin");
      await app.query(`select set_config('app.worker', 'on', true)`);
      const viaWorker = await app.query(`update organizations set registration_open = false where id = '${second.id}'`).then((r) => r.rowCount, () => -1);
      await app.query("rollback");
      expect(viaWorker).toBe(0);
    } finally { await app.end(); }
  });

  it("the runtime role cannot create organizations or alter system roles, even pretending to be the worker", async () => {
    const app = new pg.Client({ connectionString: withDb(APP, "app", DB) });
    await app.connect();
    try {
      const attempts = [
        `insert into organizations (name, slug) values ('evil', 'evil-org')`,
        `insert into roles (key, name, is_system) values ('evilrole', 'evilrole', true)`,
        `delete from role_permissions`,
        `update roles set name = 'x' where org_id is null`,
      ];
      for (const stmt of attempts) {
        await app.query("begin");
        await app.query(`select set_config('app.worker', 'on', true)`);
        const before = (await sup.query(`select (select count(*) from roles)::int as r, (select count(*) from role_permissions)::int as p, (select count(*) from organizations)::int as o`)).rows[0];
        let changed = false;
        try { const r = await app.query(stmt); changed = (r.rowCount ?? 0) > 0; } catch { /* refused: good */ }
        await app.query("rollback");
        const after = (await sup.query(`select (select count(*) from roles)::int as r, (select count(*) from role_permissions)::int as p, (select count(*) from organizations)::int as o`)).rows[0];
        expect(changed, stmt).toBe(false);
        expect(after, stmt).toEqual(before);
      }
    } finally { await app.end(); }
  });

  it("the runtime role passes the RLS-enforceable check", async () => {
    const { db, close } = createDb(withDb(APP, "app", DB));
    try {
      expect(await checkRlsEnforceable(db)).toBeNull();
    } finally { await close(); }
  });

  it("the owner itself is NOT acceptable as the runtime role: it can create organizations and the guard says so", async () => {
    const owner = new pg.Client({ connectionString: withDb(OWNER, "owner", DB) });
    await owner.connect();
    try {
      // the hazard: the owner-only policies apply to whoever connects as the owner
      await owner.query("begin");
      const made = await owner.query(`insert into organizations (name, slug) values ('Made by the runtime', 'made-by-owner')`).then(() => true, () => false);
      await owner.query("rollback");
      expect(made).toBe(true);
    } finally { await owner.end(); }

    const { db, close } = createDb(withDb(OWNER, "owner", DB));
    try {
      expect(await checkRlsEnforceable(db)).toMatch(/owns the tables/);
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

  it("a deleted organization is not invited into again, and two bootstraps at the same moment create only one organization", async () => {
    const { db, close } = createDb(withDb(OWNER, "owner", DB));
    const live = (await sup.query(`select id from organizations where deleted_at is null`)).rows.map((r) => r.id as string);
    try {
      await sup.query(`update organizations set deleted_at = now() where deleted_at is null`);
      // the code of a deleted organization
      const dead = (await sup.query(`insert into organizations (name, slug, deleted_at) values ('Dead', 'dead-org', now()) returning id`)).rows[0].id as string;
      await expect(bootstrapOrganization(db, { name: "Dead", slug: "dead-org", adminEmail: "x@example.test", appUrl: "https://tasks.example.test" })).rejects.toThrow(/was deleted/);
      expect((await sup.query(`select count(*)::int as n from invitations where org_id = $1`, [dead])).rows[0].n).toBe(0);
      // many at once, different codes: exactly one may win
      const codes = Array.from({ length: 8 }, (_, i) => `race-${i}`);
      const results = await Promise.allSettled(codes.map((slug) => bootstrapOrganization(db, { name: slug, slug, adminEmail: `${slug}@example.test`, appUrl: "https://tasks.example.test" })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect(String(r.reason)).toMatch(/already has an organization/);
      expect((await sup.query(`select count(*)::int as n from organizations where slug like 'race-%'`)).rows[0].n).toBe(1);
    } finally {
      await sup.query(`update organizations set deleted_at = now() where slug like 'race-%' or slug = 'dead-org'`);
      if (live.length) await sup.query(`update organizations set deleted_at = null where id = any($1::uuid[])`, [live]);
      await close();
    }
  });

  it("bootstrap and the system-role sync take turns: each waits while another operator holds its lock", async () => {
    const { db, close } = createDb(withDb(OWNER, "owner", DB));
    const live = (await sup.query(`select id from organizations where deleted_at is null`)).rows.map((r) => r.id as string);
    const waiting = async (p: Promise<unknown>) => (await Promise.race([p.then(() => "done", () => "done"), new Promise<string>((r) => setTimeout(() => r("waiting"), 500))])) === "waiting";
    try {
      await sup.query(`update organizations set deleted_at = now() where deleted_at is null`);
      for (const key of ["task-tracker:system-roles", "task-tracker:bootstrap"]) {
        await sup.query(`select pg_advisory_lock(hashtext($1))`, [key]);
        const run = bootstrapOrganization(db, { name: "Locked", slug: `locked-${key.split(":")[1]}`, adminEmail: "l@example.test", appUrl: "https://tasks.example.test" });
        const stuck = await waiting(run);
        await sup.query(`select pg_advisory_unlock(hashtext($1))`, [key]);
        expect(stuck, key).toBe(true);
        await run;
        await sup.query(`update organizations set deleted_at = now() where slug like 'locked-%'`);
      }
    } finally {
      await sup.query(`update organizations set deleted_at = now() where slug like 'locked-%'`);
      if (live.length) await sup.query(`update organizations set deleted_at = null where id = any($1::uuid[])`, [live]);
      await close();
    }
  });
});
