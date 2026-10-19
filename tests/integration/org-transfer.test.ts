import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { assignRole, createCustomRole, createInvitation } from "@/data/account";
import { createField } from "@/data/custom-fields";
import { syncSystemRoles } from "@/data/system-roles";
import { addComment, addDependency, createLabel, createTask, setTaskLabels } from "@/data/tasks";
import { withTenant } from "@/data/tenant";
import { createView } from "@/data/views";
import { createDb } from "@/db/client";
import { attachments, authAccounts, memberships, notifications, users } from "@/db/schema";
import { bundleChecksum, exportOrganization, importOrganization, openBundle, orderSelfReferences, sealBundle, type OrgBundle } from "@/ops/org-transfer";
import { runMigrations } from "../../scripts/migrate";
import { Client, linkIn, makeAuthApp } from "./auth-helpers";
import { APP_ROLE } from "./global-setup";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
const SOURCE_URL = process.env.TEST_DATABASE_URL!;
const TARGET_NAME = "tasktracker_test_xfer";
const TARGET_URL = (() => { const u = new URL(SOURCE_URL); u.pathname = `/${TARGET_NAME}`; return u.toString(); })();

let src: pg.Client;
let dst: pg.Client;
let dstDb: ReturnType<typeof createDb>;
let O: Awaited<ReturnType<typeof makeOrg>>;
let X: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string; email: string }> = {};
const HASH = "SCRYPT-HASH-THAT-MUST-NEVER-TRAVEL";
const TRICKY = "multi\nline \"quoted\" \\ back ไทย 🙂 ' ; drop table tasks; --";

async function freshTarget() {
  await dst.query("drop schema if exists public cascade");
  await dst.query("drop schema if exists drizzle cascade");
  await dst.query("create schema public");
  await runMigrations(TARGET_URL);
  await dst.query(readFileSync("scripts/grants.sql", "utf8").replaceAll("{{APP_ROLE}}", APP_ROLE));
  await syncSystemRoles(dstDb.db);
}

/** Role ids differ between databases; compare by role key, and rows by content rather than by order. */
function normalize(b: OrgBundle) {
  const keyOf = new Map(b.systemRoles.map((r) => [r.id, r.key]));
  const roleCols: Record<string, string[]> = { role_assignments: ["role_id"], invitations: ["role_id"], role_permissions: ["role_id"] };
  const out: Record<string, string[]> = {};
  for (const [t, rows] of Object.entries(b.tables)) {
    out[t] = rows
      .map((r) => { const copy = { ...r }; for (const col of roleCols[t] ?? []) if (keyOf.has(copy[col] as string)) copy[col] = `system:${keyOf.get(copy[col] as string)}`; return JSON.stringify(copy, Object.keys(copy).sort()); })
      .sort();
  }
  return { out, users: b.users.map((x) => JSON.stringify(x, Object.keys(x).sort())).sort() };
}
const rewrap = (b: OrgBundle, mutate: (b: OrgBundle) => void): OrgBundle => {
  const copy = JSON.parse(JSON.stringify(b)) as OrgBundle;
  mutate(copy);
  copy.checksum = bundleChecksum(copy);
  return copy;
};

beforeAll(async () => {
  src = new pg.Client({ connectionString: SOURCE_URL });
  await src.connect();
  await src.query(`drop database if exists ${TARGET_NAME} with (force)`);
  await src.query(`create database ${TARGET_NAME}`);
  dst = new pg.Client({ connectionString: TARGET_URL });
  await dst.connect();
  dstDb = createDb(TARGET_URL);
  await freshTarget();

  O = await makeOrg(c.admin, "Xfer");
  X = await makeOrg(c.admin, "XferOther");
  for (const k of ["admin", "mem", "xadmin", "outsider"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.mem!.id, { role: "member" });
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
  await addMember(c.admin, X.org.id, u.outsider!.id, { role: "member" });
  await c.admin.update(users).set({ isPlatformAdmin: true, twoFactorEnabled: true }).where(eq(users.id, u.mem!.id));
  await c.admin.insert(authAccounts).values({ accountId: u.mem!.id, providerId: "credential", userId: u.mem!.id, password: HASH });

  const as = (k: string, org = O.org.id) => ({ userId: u[k]!.id, orgId: org });
  const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2], org?: string) => withTenant(c.app, as(k, org), fn);
  const field = await run("admin", (s) => createField(s, { name: "Cost", type: "number" }));
  const parent = await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Parent", description: TRICKY, customFields: { [field.id]: 42 } }));
  const child = await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Child", parentId: parent.id, primaryAssigneeId: u.mem!.id }));
  const grand = await run("mem", (s) => createTask(s, { projectId: O.project.id, title: "Grandchild", parentId: child.id }));
  await run("admin", (s) => addDependency(s, grand.id, parent.id));
  const label = await run("admin", (s) => createLabel(s, { name: "urgent" }));
  await run("admin", (s) => setTaskLabels(s, parent.id, [label.id]));
  await run("admin", (s) => addComment(s, parent.id, { body: `hello ${TRICKY}`, mentionUserIds: [u.mem!.id] }));
  const role = await run("admin", (s) => createCustomRole(s, { key: "auditor", name: "Auditor", permissions: ["org.read", "task.read"] }));
  const [memMembership] = await c.admin.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.orgId, O.org.id), eq(memberships.userId, u.mem!.id)));
  await run("admin", (s) => assignRole(s, { membershipId: memMembership!.id, roleId: role.id, scope: { type: "organization" } }));
  await run("admin", (s) => createView(s, { name: "Mine", kind: "list", scope: "personal", filter: {} }));
  await run("admin", (s) => createInvitation(s, { email: "invitee@example.test", roleId: role.id }));
  await c.admin.insert(notifications).values({ orgId: O.org.id, userId: u.mem!.id, type: "task.assigned", taskId: child.id, dedupeKey: "xfer-1", params: { status: "todo" } });
  await c.admin.insert(attachments).values({ orgId: O.org.id, taskId: parent.id, uploadedBy: u.admin!.id, storageKey: `xfer-${O.org.id}`, filename: "f.pdf", contentType: "application/pdf", sizeBytes: 5, sha256: "ab".repeat(32) });
  // the other tenant has data too: it must never end up in, or be touched by, the first organization's bundle
  await withTenant(c.app, as("xadmin", X.org.id), (s) => createTask(s, { projectId: X.project.id, title: "Other tenant secret" }));
  await withTenant(c.app, as("xadmin", X.org.id), (s) => createCustomRole(s, { key: "reviewer", name: "Other tenant role", permissions: ["task.read"] }));
});

afterAll(async () => {
  await dst?.end();
  await dstDb?.close();
  await src?.query(`drop database if exists ${TARGET_NAME} with (force)`).catch(() => undefined);
  await src?.end();
  await c.close();
});

describe("export", () => {
  it("holds exactly one organization, discovered from the schema, in foreign-key order, without credentials", async () => {
    const b = await exportOrganization(src, O.org.slug);
    expect(b.org.id).toBe(O.org.id);
    expect(b.counts.tasks).toBe(3);
    expect(b.counts.comments).toBe(1);
    expect(b.counts.comment_mentions).toBe(1);
    expect(b.counts.attachments).toBe(1);
    expect(b.counts.role_permissions).toBe(2); // only the organization's own custom role
    expect(b.tableOrder.indexOf("organizations")).toBeLessThan(b.tableOrder.indexOf("tasks"));
    expect(b.tableOrder.indexOf("tasks")).toBeLessThan(b.tableOrder.indexOf("task_dependencies"));
    expect(b.tableOrder).not.toContain("jobs");
    // parents come before children inside one table
    const titles = b.tables.tasks!.map((t) => t.title);
    expect(titles.indexOf("Parent")).toBeLessThan(titles.indexOf("Child"));
    expect(titles.indexOf("Child")).toBeLessThan(titles.indexOf("Grandchild"));

    const text = JSON.stringify(b);
    expect(text).not.toContain("Other tenant secret");
    expect(text).not.toContain(X.org.id);
    expect(text).not.toContain(u.xadmin!.id);
    expect(text).not.toContain(u.outsider!.id);
    expect(text).not.toContain(HASH);
    expect(b.users.map((x) => x.id).sort()).toEqual([u.admin!.id, u.mem!.id].sort());
    expect(Object.keys(b.users[0]!).sort()).toEqual(["created_at", "deleted_at", "email", "email_verified", "id", "image", "locale", "name", "timezone", "updated_at"]);
    expect(b.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the code or the id, and refuses an unknown organization", async () => {
    expect((await exportOrganization(src, O.org.id)).org.slug).toBe(O.org.slug);
    await expect(exportOrganization(src, "no-such-organization")).rejects.toThrow(/no organization/);
  });

  it("refuses the application's least-privilege runtime role (it cannot see every row, and a partial export would look complete)", async () => {
    const u2 = new URL(SOURCE_URL); u2.username = APP_ROLE; u2.password = "app";
    const app = new pg.Client({ connectionString: u2.toString() });
    await app.connect();
    try { await expect(exportOrganization(app, O.org.slug)).rejects.toThrow(/operator role/); } finally { await app.end(); }
  });
});

describe("import into another database", () => {
  it("a dry run changes nothing and reports the plan", async () => {
    const b = await exportOrganization(src, O.org.slug);
    const plan = await importOrganization(dst, b);
    expect(plan).toMatchObject({ applied: false, exists: false, usersToCreate: 2 });
    expect(plan.incomingRows.tasks).toBe(3);
    expect((await dst.query("select count(*)::int as n from organizations")).rows[0].n).toBe(0);
    expect((await dst.query("select count(*)::int as n from users")).rows[0].n).toBe(0);
  });

  it("restores the whole organization: every table identical (system roles matched by key), users without credentials or privileges", async () => {
    const b = await exportOrganization(src, O.org.slug);
    const plan = await importOrganization(dst, b, { apply: true });
    expect(plan.applied).toBe(true);

    const back = await exportOrganization(dst, O.org.slug);
    expect(back.counts).toEqual(b.counts);
    const [a, z] = [normalize(b), normalize(back)];
    for (const t of b.tableOrder) expect(z.out[t], t).toEqual(a.out[t]);
    expect(z.users.map((x) => JSON.parse(x).id).sort()).toEqual(a.users.map((x) => JSON.parse(x).id).sort());

    // the sensitive parts of a user did not travel
    const imported = (await dst.query("select is_platform_admin, two_factor_enabled from users where id = $1", [u.mem!.id])).rows[0];
    expect(imported).toEqual({ is_platform_admin: false, two_factor_enabled: false });
    expect((await dst.query("select count(*)::int as n from auth_accounts")).rows[0].n).toBe(0);
    expect((await dst.query("select count(*)::int as n from auth_sessions")).rows[0].n).toBe(0);
    // the original keeps its own flags
    expect((await src.query("select is_platform_admin from users where id = $1", [u.mem!.id])).rows[0].is_platform_admin).toBe(true);
    // tricky text survived byte for byte
    expect((await dst.query("select description from tasks where title = 'Parent'")).rows[0].description).toBe(TRICKY);
    // rows of the other tenant are not here
    expect((await dst.query("select count(*)::int as n from organizations where id = $1", [X.org.id])).rows[0].n).toBe(0);
    // the restored role assignments use THIS database's system role ids
    const bad = await dst.query("select count(*)::int as n from role_assignments ra left join roles r on r.id = ra.role_id where r.id is null");
    expect(bad.rows[0].n).toBe(0);
  });

  it("refuses to overwrite without --replace, and refuses a different organization that uses the same code", async () => {
    const b = await exportOrganization(src, O.org.slug);
    await expect(importOrganization(dst, b, { apply: true })).rejects.toThrow(/already exists/);
    const NEW_ID = "00000000-0000-4000-8000-0000000000aa";
    const renamed = rewrap(b, (x) => {
      x.org.id = NEW_ID;
      for (const rows of Object.values(x.tables)) for (const r of rows) { if ("org_id" in r) r.org_id = NEW_ID; }
      x.tables.organizations![0]!.id = NEW_ID;
    });
    await expect(importOrganization(dst, renamed, { apply: true })).rejects.toThrow(/another organization already uses the code/);
  });

  it("refuses an e-mail address that belongs to a different account in the target, and changes nothing", async () => {
    await freshTarget();
    await dst.query("insert into users (email, name) values ($1, 'Impostor')", [u.admin!.email]);
    const b = await exportOrganization(src, O.org.slug);
    await expect(importOrganization(dst, b, { apply: true })).rejects.toThrow(/already belong to different accounts/);
    expect((await dst.query("select count(*)::int as n from organizations")).rows[0].n).toBe(0);
  });

  it("existing users in the target keep their credentials", async () => {
    await freshTarget();
    await dst.query("insert into users (id, email, name) values ($1, $2, 'Already here')", [u.admin!.id, u.admin!.email]);
    await dst.query("insert into auth_accounts (account_id, provider_id, user_id, password) values ($1::text, 'credential', $1::uuid, 'LOCAL-HASH')", [u.admin!.id]);
    const b = await exportOrganization(src, O.org.slug);
    const plan = await importOrganization(dst, b, { apply: true });
    expect(plan.usersAlreadyPresent).toBe(1);
    expect((await dst.query("select name from users where id = $1", [u.admin!.id])).rows[0].name).toBe("Already here");
    expect((await dst.query("select password from auth_accounts where user_id = $1", [u.admin!.id])).rows[0].password).toBe("LOCAL-HASH");
  });
});

describe("people who come back through an import", () => {
  it("have no password after the import and regain access with the normal 'forgot password' e-mail", async () => {
    await src.query("update users set email_verified = true where id = $1", [u.admin!.id]);
    const b = await exportOrganization(src, O.org.slug);
    await freshTarget();
    await importOrganization(dst, b, { apply: true });
    expect((await dst.query("select count(*)::int as n from auth_accounts where user_id = $1", [u.admin!.id])).rows[0].n).toBe(0);

    const runtimeUrl = new URL(TARGET_URL); runtimeUrl.username = APP_ROLE; runtimeUrl.password = "app";
    const runtime = createDb(runtimeUrl.toString());
    try {
      const app = makeAuthApp(runtime.db);
      const NEW = "restored-access-password-1";
      expect((await new Client(app.auth).authCall("POST", "/sign-in/email", { email: u.admin!.email, password: "anything-at-all-123" })).status).toBeGreaterThanOrEqual(400);
      const client = new Client(app.auth);
      expect((await client.authCall("POST", "/request-password-reset", { email: u.admin!.email, redirectTo: "/reset" })).status).toBe(200);
      const mail = app.email.sent.at(-1)!;
      expect(mail.to).toBe(u.admin!.email);
      const token = new URL(linkIn(mail.text)).pathname.split("/").pop()!;
      expect((await client.authCall("POST", "/reset-password", { newPassword: NEW, token })).status).toBe(200);
      expect((await new Client(app.auth).authCall("POST", "/sign-in/email", { email: u.admin!.email, password: NEW })).status).toBe(200);
    } finally {
      await runtime.close();
    }
  });
});

describe("large organizations", () => {
  it("loads in several chunks, parents before children, and gets every row back", async () => {
    const B = await makeOrg(c.admin, "XferBig");
    const owner = await makeUser(c.admin, "bigowner");
    await addMember(c.admin, B.org.id, owner.id, { role: "orgadmin" });
    // one parent and 1 100 children: more rows than one import chunk (500)
    await src.query(
      `insert into tasks (id, org_id, project_id, title, created_by, parent_id)
         select '00000000-0000-4000-8000-000000000001'::uuid, $1::uuid, $2::uuid, 'The parent', $3::uuid, null::uuid
       union all
         select gen_random_uuid(), $1::uuid, $2::uuid, 'Child ' || g, $3::uuid, '00000000-0000-4000-8000-000000000001'::uuid from generate_series(1, 1100) g`,
      [B.org.id, B.project.id, owner.id],
    );
    const bundle = await exportOrganization(src, B.org.slug);
    expect(bundle.tables.tasks).toHaveLength(1101);

    await freshTarget();
    await importOrganization(dst, bundle, { apply: true });
    expect((await dst.query("select count(*)::int as n from tasks where org_id = $1", [B.org.id])).rows[0].n).toBe(1101);
    expect((await dst.query("select count(*)::int as n from tasks where parent_id = '00000000-0000-4000-8000-000000000001'")).rows[0].n).toBe(1100);

    // a bundle written with the children first would fail across the chunk boundary: the import must not depend on luck
    const shuffled = rewrap(bundle, (x) => { x.tables.tasks!.reverse(); });
    await freshTarget();
    await expect(importOrganization(dst, shuffled, { apply: true })).rejects.toThrow();
    expect((await dst.query("select count(*)::int as n from organizations")).rows[0].n).toBe(0);
  });
});

describe("ordering rows inside one table", () => {
  const fk = { child: "tasks", parent: "tasks", childCols: ["org_id", "parent_id"], parentCols: ["org_id", "id"] };
  const t = (id: string, parent: string | null) => ({ org_id: "o", id, parent_id: parent });
  it("puts every parent before its children, whatever order the rows come in", () => {
    const rows = [t("d", "c"), t("c", "b"), t("b", "a"), t("x", null), t("a", null), t("e", "a")];
    const ids = orderSelfReferences(rows, fk).map((r) => r.id as string);
    expect(ids.sort()).toEqual(["a", "b", "c", "d", "e", "x"]);
    const sorted = orderSelfReferences(rows, fk).map((r) => r.id as string);
    for (const [child, parent] of [["d", "c"], ["c", "b"], ["b", "a"], ["e", "a"]] as const) expect(sorted.indexOf(parent), `${parent} before ${child}`).toBeLessThan(sorted.indexOf(child));
  });
  it("refuses a cycle instead of looping", () => {
    expect(() => orderSelfReferences([t("a", "b"), t("b", "a")], fk)).toThrow(/cycle/);
  });
});

describe("replace (partial restore in the same database)", () => {
  it("puts one organization back to the bundle's state without touching any other organization", async () => {
    const before = await exportOrganization(src, O.org.slug);
    const otherBefore = await exportOrganization(src, X.org.slug);

    // damage: edit, delete and add things after the bundle was taken
    await src.query("update tasks set title = 'VANDALISED' where org_id = $1", [O.org.id]);
    await src.query("delete from comment_mentions where org_id = $1", [O.org.id]);
    await src.query("delete from comments where org_id = $1", [O.org.id]);
    await src.query("delete from task_labels where org_id = $1", [O.org.id]);
    await src.query("delete from labels where org_id = $1", [O.org.id]);
    await src.query("insert into tasks (org_id, project_id, title, created_by) values ($1, $2, 'Junk added later', $3)", [O.org.id, O.project.id, u.admin!.id]);
    await src.query("update organizations set name = 'Renamed later' where id = $1", [O.org.id]);
    await src.query("insert into jobs (kind, org_id, payload, run_at) values ('calendar.reconcile', $1, '{}'::jsonb, now())", [O.org.id]).catch(() => undefined);

    const dry = await importOrganization(src, before, { replace: true });
    expect(dry.applied).toBe(false);
    expect(dry.existingRows.tasks).toBe(4);
    expect((await src.query("select count(*)::int as n from tasks where org_id = $1 and title = 'VANDALISED'", [O.org.id])).rows[0].n).toBe(3); // still damaged

    const done = await importOrganization(src, before, { replace: true, apply: true });
    expect(done.applied).toBe(true);
    const after = await exportOrganization(src, O.org.slug);
    expect(normalize(after)).toEqual(normalize(before));
    expect(after.counts).toEqual(before.counts);
    expect(normalize(await exportOrganization(src, X.org.slug))).toEqual(normalize(otherBefore));
  });

  it("keeps the registration switch as it is now: restoring an older bundle never re-opens a closed registration", async () => {
    await src.query("update organizations set registration_open = true where id = $1", [O.org.id]);
    const older = await exportOrganization(src, O.org.slug); // taken while registration was open
    await src.query("update organizations set registration_open = false where id = $1", [O.org.id]);
    await importOrganization(src, older, { replace: true, apply: true });
    expect((await src.query("select registration_open as open from organizations where id = $1", [O.org.id])).rows[0].open).toBe(false);
    // and the other direction: open now, bundle taken while closed
    const closed = await exportOrganization(src, O.org.slug);
    await src.query("update organizations set registration_open = true where id = $1", [O.org.id]);
    await importOrganization(src, closed, { replace: true, apply: true });
    expect((await src.query("select registration_open as open from organizations where id = $1", [O.org.id])).rows[0].open).toBe(true);
  });

  it("is all-or-nothing: a bundle that fails half way leaves the organization exactly as it was", async () => {
    const good = await exportOrganization(src, O.org.slug);
    const snapshot = normalize(good);
    const poisoned = rewrap(good, (x) => {
      x.tables.tasks!.push({ ...x.tables.tasks![0]!, id: "11111111-1111-4111-8111-111111111111", project_id: "22222222-2222-4222-8222-222222222222" });
    });
    await expect(importOrganization(src, poisoned, { replace: true, apply: true })).rejects.toThrow();
    expect(normalize(await exportOrganization(src, O.org.slug))).toEqual(snapshot);
  });
});

describe("a hand-built bundle (checksum recomputed) cannot reach into another organization", () => {
  it("refuses rows that belong to a different organization, before anything is written", async () => {
    const good = await exportOrganization(src, O.org.slug);
    const otherBefore = normalize(await exportOrganization(src, X.org.slug));
    const snapshot = normalize(good);
    const cases: [string, OrgBundle][] = [
      ["tasks", rewrap(good, (x) => { x.tables.tasks!.push({ ...x.tables.tasks![0]!, id: "33333333-3333-4333-8333-333333333333", org_id: X.org.id, project_id: X.project.id }); })],
      ["labels", rewrap(good, (x) => { x.tables.labels!.push({ ...x.tables.labels![0]!, id: "44444444-4444-4444-8444-444444444444", org_id: X.org.id }); })],
      ["organizations", rewrap(good, (x) => { x.tables.organizations![0] = { ...x.tables.organizations![0]!, id: X.org.id }; })],
    ];
    for (const [table, bundle] of cases) {
      await expect(importOrganization(src, bundle, { replace: true, apply: true }), table).rejects.toThrow(/another organization|belongs to/);
      await expect(importOrganization(src, bundle, { replace: true }), `${table} (dry run)`).rejects.toThrow(/another organization|belongs to/);
    }
    expect(normalize(await exportOrganization(src, O.org.slug))).toEqual(snapshot);
    expect(normalize(await exportOrganization(src, X.org.slug))).toEqual(otherBefore);
  });

  it("refuses permissions that point at a role of another organization", async () => {
    const good = await exportOrganization(src, O.org.slug);
    expect((good.tables.role_permissions ?? []).length).toBeGreaterThan(0);
    const foreignRole = (await src.query<{ id: string }>("select id from roles where org_id = $1 limit 1", [X.org.id])).rows[0]?.id;
    expect(foreignRole).toBeTruthy();
    const bad = rewrap(good, (x) => { x.tables.role_permissions!.push({ ...x.tables.role_permissions![0]!, role_id: foreignRole! }); });
    await expect(importOrganization(src, bad, { replace: true, apply: true })).rejects.toThrow(/role_permissions belongs to another organization/);
  });
});

describe("sealed files", () => {
  const PASS = "a long enough passphrase";

  it("with a passphrase set, a file that is not encrypted is refused: it proves nothing about who wrote it", async () => {
    const b = await exportOrganization(src, O.org.slug);
    const forged = sealBundle(rewrap(b, (x) => { x.tables.tasks![0]!.title = "forged"; }));
    expect(() => openBundle(forged, PASS)).toThrow(/not encrypted/);
    expect(openBundle(forged, PASS, { allowUnsealed: true }).tables.tasks![0]!.title).toBe("forged"); // an explicit, visible choice
    expect(openBundle(forged).tables.tasks![0]!.title).toBe("forged"); // no passphrase configured: nothing to compare with
  });

  it("a cut-off sealed file gives the same plain message as a wrong passphrase, whatever length it was cut to", async () => {
    const sealed = sealBundle(await exportOrganization(src, O.org.slug), PASS);
    for (const n of [0, 3, 7, 20, 40, 50, 60, sealed.length - 1]) {
      const cut = sealed.subarray(0, n);
      if (n < 7) continue; // too short to be recognised as sealed at all
      expect(() => openBundle(cut, PASS), `cut to ${n}`).toThrow(/wrong passphrase|damaged|not encrypted|not a valid/);
    }
  });

  it("files written with the older, lighter key derivation can still be read", async () => {
    const { createCipheriv, randomBytes, scryptSync } = await import("node:crypto");
    const { gzipSync } = await import("node:zlib");
    const b = await exportOrganization(src, O.org.slug);
    const salt = randomBytes(16), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", scryptSync(PASS, salt, 32), iv);
    const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(b)))), cipher.final()]);
    const legacy = Buffer.concat([Buffer.from("TTORG1\n"), salt, iv, cipher.getAuthTag(), body]);
    expect(openBundle(legacy, PASS).checksum).toBe(b.checksum);
    expect(sealBundle(b, PASS).subarray(0, 7).toString()).toBe("TTORG2\n"); // new files use the stronger setting
  });

  it("refuses a file that unpacks to more than the allowed size", async () => {
    const { gzipSync } = await import("node:zlib");
    const bomb = gzipSync(Buffer.alloc(5_000_000, 97));
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => openBundle(bomb, undefined, { maxBytes: 1_000_000 })).toThrow(/more than the allowed size/);
    expect(() => openBundle(Buffer.from("not gzip at all"))).toThrow(/not a valid organization export/);
  });
});

describe("export finds every table, including ones the exporting role has no right to read", () => {
  it("fails loudly instead of leaving a table out", async () => {
    const role = `tt_blind_${Math.random().toString(36).slice(2, 8)}`;
    await src.query(`create role ${role} login password 'x' bypassrls`);
    try {
      await src.query(`grant usage on schema public, drizzle to ${role}`);
      await src.query(`grant select on all tables in schema public to ${role}`);
      await src.query(`grant select on all tables in schema drizzle to ${role}`); // the migration table is read for the schema fingerprint
      await src.query(`revoke select on labels from ${role}`);
      const u = new URL(SOURCE_URL); u.username = role; u.password = "x";
      const blind = new pg.Client({ connectionString: u.toString() });
      await blind.connect();
      try {
        // information_schema would not list `labels` for this role and the bundle would simply be missing it
        await expect(exportOrganization(blind, O.org.slug)).rejects.toThrow(/permission denied for table labels/);
      } finally { await blind.end(); }
    } finally {
      await src.query(`drop owned by ${role}`);
      await src.query(`drop role ${role}`);
    }
  });
});

describe("bundle integrity", () => {
  it("rejects a bundle whose content was changed after it was written", async () => {
    const b = await exportOrganization(src, O.org.slug);
    const tampered = JSON.parse(JSON.stringify(b)) as OrgBundle;
    tampered.tables.tasks![0]!.title = "Edited by hand";
    await expect(importOrganization(dst, tampered)).rejects.toThrow(/checksum mismatch/);
  });

  it("rejects a bundle from a database with a different schema", async () => {
    const b = await exportOrganization(src, O.org.slug);
    const other = rewrap(b, (x) => { x.schema = { migrations: x.schema.migrations + 1, fingerprint: "0".repeat(64) }; });
    await expect(importOrganization(dst, other)).rejects.toThrow(/schema mismatch/);
  });

  it("rejects foreign files and unknown versions", async () => {
    await expect(importOrganization(dst, { format: "something-else" } as never)).rejects.toThrow(/not an organization export/);
    const b = await exportOrganization(src, O.org.slug);
    await expect(importOrganization(dst, { ...b, version: 99 })).rejects.toThrow(/unsupported bundle version/);
  });

  it("the file can be compressed and sealed with a passphrase; a wrong passphrase or a flipped bit is refused", async () => {
    const b = await exportOrganization(src, O.org.slug);
    const plain = sealBundle(b);
    expect(plain.length).toBeLessThan(JSON.stringify(b).length);
    expect(openBundle(plain).checksum).toBe(b.checksum);

    const sealed = sealBundle(b, "a long enough passphrase");
    expect(sealed.includes(Buffer.from("Parent"))).toBe(false); // nothing readable
    expect(sealed.includes(Buffer.from(TRICKY.slice(0, 10)))).toBe(false);
    expect(openBundle(sealed, "a long enough passphrase").checksum).toBe(b.checksum);
    expect(() => openBundle(sealed)).toThrow(/ORG_EXPORT_PASSPHRASE/);
    expect(() => openBundle(sealed, "another long passphrase")).toThrow(/wrong passphrase/);
    const flipped = Buffer.from(sealed); flipped[flipped.length - 5] = flipped[flipped.length - 5]! ^ 1;
    expect(() => openBundle(flipped, "a long enough passphrase")).toThrow(/wrong passphrase|damaged/);
    expect(() => sealBundle(b, "short")).toThrow(/at least 12/);
  });
});
