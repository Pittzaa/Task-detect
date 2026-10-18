import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addComment, createTask } from "@/data/tasks";
import { withTenant } from "@/data/tenant";
import { ERASED_DOMAIN, ERASED_NAME } from "@/data/privacy";
import {
  attachments, auditLogs, authAccounts, authSessions, authTwoFactor, calendarConnections, comments, jobs, memberships, notificationPrefs, notifications,
  roleAssignments, savedViews, taskAssignees, tasks, users,
} from "@/db/schema";
import { DELETE as eraseRoute } from "@/app/api/me/route";
import { GET as exportRoute } from "@/app/api/me/export/route";
import { Client, PASSWORD, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

const idOf = async (email: string) => (await c.admin.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;
const as = (userId: string, orgId: string) => ({ userId, orgId });

/** A registered, signed-in user (a real password hash and session) who is a member of a fresh organization with a colleague administrator. */
async function person(label: string, role = "member") {
  const { client, email } = await registerAndSignIn(app, label);
  const id = await idOf(email);
  const O = await makeOrg(c.admin, `Priv${label}`);
  const boss = await makeUser(c.admin, `boss-${label}`);
  await addMember(c.admin, O.org.id, boss.id, { role: "orgadmin" });
  const m = await addMember(c.admin, O.org.id, id, { role });
  return { client, email, id, O, boss, membershipId: m.id };
}

const erase = (client: Client, body: unknown) => client.route(eraseRoute as never, "DELETE", "/api/me", body);

describe("personal data export", () => {
  it("contains what the user authored or is assigned to, and nothing of other people's or of credentials", async () => {
    const p = await person("exp");
    const bystander = await makeUser(c.admin, "bystander");
    await addMember(c.admin, p.O.org.id, bystander.id, { role: "member" });

    const mine = await withTenant(c.app, as(p.id, p.O.org.id), (s) => createTask(s, { projectId: p.O.project.id, title: "My own task", description: "my description" }));
    await withTenant(c.app, as(p.id, p.O.org.id), (s) => addComment(s, mine.id, { body: "my comment" }));
    const assignedToMe = await withTenant(c.app, as(p.boss.id, p.O.org.id), (s) => createTask(s, { projectId: p.O.project.id, title: "Boss task for me", primaryAssigneeId: p.id }));
    await withTenant(c.app, as(p.boss.id, p.O.org.id), (s) => createTask(s, { projectId: p.O.project.id, title: "Someone else's secret plan", description: "classified" }));
    await withTenant(c.app, as(bystander.id, p.O.org.id), (s) => createTask(s, { projectId: p.O.project.id, title: "Bystander task" }));
    await c.admin.insert(notificationPrefs).values({ orgId: p.O.org.id, userId: p.id, digest: "daily" });
    await c.admin.insert(attachments).values({ orgId: p.O.org.id, taskId: mine.id, uploadedBy: p.id, storageKey: `k-${randomUUID()}`, filename: "plan.pdf", contentType: "application/pdf", sizeBytes: 1234, sha256: "ab".repeat(32) });

    const res = await p.client.route(exportRoute as never, "GET", "/api/me/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="my-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const data = JSON.parse(text);

    expect(data.profile).toMatchObject({ id: p.id, email: p.email });
    expect(data.organizations).toHaveLength(1);
    const org = data.organizations[0];
    expect(org.tasks.map((t: { title: string }) => t.title).sort()).toEqual(["Boss task for me", "My own task"]);
    expect(org.comments.map((x: { body: string }) => x.body)).toEqual(["my comment"]);
    expect(org.attachments).toEqual([expect.objectContaining({ filename: "plan.pdf", sizeBytes: 1234 })]);
    expect(org.notificationPreferences).toMatchObject({ digest: "daily" });
    expect(org.tasksNotShown).toBe(0);
    expect(data.signIn.providers).toEqual(["credential"]);
    expect(assignedToMe.id).toBeTruthy();

    expect(text).not.toContain("Someone else's secret plan");
    expect(text).not.toContain("classified");
    expect(text).not.toContain("Bystander");
    expect(text).not.toContain(p.boss.email);
    // credentials never leave the server
    const [acct] = await c.admin.select().from(authAccounts).where(eq(authAccounts.userId, p.id));
    const [sess] = await c.admin.select().from(authSessions).where(eq(authSessions.userId, p.id));
    expect(text).not.toContain(acct!.password!);
    expect(text).not.toContain(sess!.token);
  });

  it("counts, but does not list, work the user can no longer open", async () => {
    const p = await person("expscope", "viewer");
    // narrow the user to project P1 only, then attribute a task in another project to them
    await c.admin.delete(roleAssignments).where(eq(roleAssignments.membershipId, p.membershipId));
    const [other] = await c.admin.execute(sql`insert into projects (org_id, name) values (${p.O.org.id}, 'Hidden') returning id`).then((r) => (r as unknown as { rows: { id: string }[] }).rows);
    await c.admin.insert(tasks).values({ orgId: p.O.org.id, projectId: other!.id, title: "In a project I cannot read", createdBy: p.boss.id, primaryAssigneeId: p.id });
    const data = await (await p.client.route(exportRoute as never, "GET", "/api/me/export")).json();
    expect(data.organizations[0].tasks).toEqual([]);
    expect(data.organizations[0].tasksNotShown).toBe(1);
    expect(JSON.stringify(data)).not.toContain("In a project I cannot read");
  });

  it("requires a session", async () => {
    const res = await new Client(app.auth).route(exportRoute as never, "GET", "/api/me/export");
    expect(res.status).toBe(401);
  });
});

describe("account erasure: refusals change nothing", () => {
  it("needs the exact e-mail address and the right password", async () => {
    const p = await person("ref1");
    expect((await erase(p.client, { confirmEmail: "someone@else.test", password: PASSWORD })).status).toBe(422);
    expect((await erase(p.client, { confirmEmail: p.email })).status).toBe(422); // password missing
    expect((await erase(p.client, { confirmEmail: p.email, password: "not-the-password-0" })).status).toBe(422);
    expect((await erase(p.client, { confirmEmail: p.email, password: PASSWORD, extra: 1 })).status).toBe(422); // strict body
    const [u] = await c.admin.select().from(users).where(eq(users.id, p.id));
    expect(u).toMatchObject({ email: p.email, deletedAt: null });
    expect((await p.client.authCall("GET", "/get-session")).status).toBe(200);
  });

  it("is refused for a platform administrator", async () => {
    const p = await person("ref2");
    await c.admin.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, p.id));
    expect((await erase(p.client, { confirmEmail: p.email, password: PASSWORD })).status).toBe(409);
    expect((await c.admin.select().from(users).where(eq(users.id, p.id)))[0]!.deletedAt).toBeNull();
  });

  it("is refused, atomically, when the user is the only administrator of an organization that has other members", async () => {
    const p = await person("ref3");
    // org B: p is a harmless member (would be cleaned up) ...
    const harmless = await makeOrg(c.admin, "PrivHarmless");
    const hb = await makeUser(c.admin, "hb");
    await addMember(c.admin, harmless.org.id, hb.id, { role: "orgadmin" });
    await addMember(c.admin, harmless.org.id, p.id, { role: "member" });
    await c.admin.insert(notificationPrefs).values({ orgId: harmless.org.id, userId: p.id, digest: "weekly" });
    // ... org C: p is the only admin and a colleague exists
    const stuck = await makeOrg(c.admin, "PrivStuck");
    const colleague = await makeUser(c.admin, "colleague");
    await addMember(c.admin, stuck.org.id, p.id, { role: "orgadmin" });
    await addMember(c.admin, stuck.org.id, colleague.id, { role: "member" });

    const res = await erase(p.client, { confirmEmail: p.email, password: PASSWORD });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("only administrator");

    // nothing was applied in any organization or on the profile (one transaction)
    expect((await c.admin.select().from(memberships).where(and(eq(memberships.userId, p.id), eq(memberships.orgId, harmless.org.id))))[0]!.status).toBe("approved");
    expect(await c.admin.select().from(notificationPrefs).where(eq(notificationPrefs.userId, p.id))).toHaveLength(1);
    expect((await c.admin.select().from(users).where(eq(users.id, p.id)))[0]).toMatchObject({ email: p.email, deletedAt: null });
    expect((await p.client.authCall("GET", "/get-session")).status).toBe(200);
  });

  it("asks for explicit confirmation before leaving an organization nobody else belongs to", async () => {
    const { client, email } = await registerAndSignIn(app, "solo");
    const id = await idOf(email);
    const O = await makeOrg(c.admin, "PrivSolo");
    await addMember(c.admin, O.org.id, id, { role: "orgadmin" });
    const res = await erase(client, { confirmEmail: email, password: PASSWORD });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { data?: { needsAbandon?: boolean } } }).error.data).toEqual({ needsAbandon: true });
    expect((await c.admin.select().from(users).where(eq(users.id, id)))[0]!.deletedAt).toBeNull();

    const ok = await erase(client, { confirmEmail: email, password: PASSWORD, abandonOrganizations: true });
    expect(ok.status).toBe(200);
    expect((await c.admin.select().from(memberships).where(eq(memberships.userId, id)))[0]!.status).toBe("revoked");
    expect((await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "account.erased"))))).toHaveLength(1);
  });

  it("without a password (social sign-in only) needs a recent sign-in", async () => {
    const p = await person("ref4");
    await c.admin.delete(authAccounts).where(eq(authAccounts.userId, p.id));
    await c.admin.update(authSessions).set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(authSessions.userId, p.id));
    const stale = await erase(p.client, { confirmEmail: p.email });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).toContain("sign in again");
    expect((await c.admin.select().from(users).where(eq(users.id, p.id)))[0]!.deletedAt).toBeNull();

    await c.admin.update(authSessions).set({ createdAt: new Date() }).where(eq(authSessions.userId, p.id));
    expect((await erase(p.client, { confirmEmail: p.email })).status).toBe(200);
  });
});

describe("account erasure: what goes and what stays", () => {
  it("removes the person and their private data, keeps the organization's records attributed to 'Deleted user'", async () => {
    const p = await person("gone");
    const other = new Client(app.auth);
    expect((await other.authCall("POST", "/sign-in/email", { email: p.email, password: PASSWORD })).status).toBe(200);

    const myTask = await withTenant(c.app, as(p.id, p.O.org.id), (s) => createTask(s, { projectId: p.O.project.id, title: "Kept: authored task" }));
    await withTenant(c.app, as(p.id, p.O.org.id), (s) => addComment(s, myTask.id, { body: "Kept: authored comment" }));
    const assigned = await withTenant(c.app, as(p.boss.id, p.O.org.id), (s) => createTask(s, { projectId: p.O.project.id, title: "Assigned to the leaver", primaryAssigneeId: p.id }));
    await c.admin.insert(taskAssignees).values({ orgId: p.O.org.id, taskId: myTask.id, userId: p.id });
    await c.admin.insert(notificationPrefs).values({ orgId: p.O.org.id, userId: p.id, digest: "daily" });
    await c.admin.insert(notifications).values({ orgId: p.O.org.id, userId: p.id, type: "task.assigned", taskId: assigned.id, dedupeKey: `k-${randomUUID()}` });
    await c.admin.insert(savedViews).values({ orgId: p.O.org.id, ownerId: p.id, name: "My private view" });
    await c.admin.insert(authTwoFactor).values({ userId: p.id, secret: "s3cret", backupCodes: "codes" });
    const [conn] = await c.admin.insert(calendarConnections).values({ orgId: p.O.org.id, userId: p.id, refreshTokenCiphertext: "ciphertext", scope: "calendar.events" }).returning();
    await c.admin.insert(attachments).values({ orgId: p.O.org.id, taskId: myTask.id, uploadedBy: p.id, storageKey: `k-${randomUUID()}`, filename: "kept.pdf", contentType: "application/pdf", sizeBytes: 10, sha256: "cd".repeat(32) });

    const res = await erase(p.client, { confirmEmail: p.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizations: 1 });

    // the profile no longer identifies anyone
    const [u] = await c.admin.select().from(users).where(eq(users.id, p.id));
    expect(u).toMatchObject({ email: `erased-${p.id}@${ERASED_DOMAIN}`, name: ERASED_NAME, image: null, emailVerified: false });
    expect(u!.deletedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(u)).not.toContain(p.email);

    // sign-in material is gone and every session ends, including other devices
    expect(await c.admin.select().from(authSessions).where(eq(authSessions.userId, p.id))).toHaveLength(0);
    expect(await c.admin.select().from(authAccounts).where(eq(authAccounts.userId, p.id))).toHaveLength(0);
    expect(await c.admin.select().from(authTwoFactor).where(eq(authTwoFactor.userId, p.id))).toHaveLength(0);
    expect(((await (await other.authCall("GET", "/get-session")).json()) as { user?: unknown } | null)?.user).toBeFalsy();
    expect((await new Client(app.auth).authCall("POST", "/sign-in/email", { email: p.email, password: PASSWORD })).status).not.toBe(200);

    // private data in the organization is deleted
    expect(await c.admin.select().from(notificationPrefs).where(eq(notificationPrefs.userId, p.id))).toHaveLength(0);
    expect(await c.admin.select().from(notifications).where(eq(notifications.userId, p.id))).toHaveLength(0);
    expect(await c.admin.select().from(savedViews).where(eq(savedViews.ownerId, p.id))).toHaveLength(0);
    expect(await c.admin.select().from(roleAssignments).where(eq(roleAssignments.membershipId, p.membershipId))).toHaveLength(0);
    expect(await c.admin.select().from(taskAssignees).where(eq(taskAssignees.userId, p.id))).toHaveLength(0);
    expect((await c.admin.select().from(memberships).where(eq(memberships.id, p.membershipId)))[0]!.status).toBe("revoked");
    // work is no longer assigned to a person who is gone
    expect((await c.admin.select().from(tasks).where(eq(tasks.id, assigned.id)))[0]!.primaryAssigneeId).toBeNull();

    // the calendar link is wound down by the existing cleanup job (events deleted, token revoked there)
    expect((await c.admin.select().from(calendarConnections).where(eq(calendarConnections.id, conn!.id)))[0]!.status).toBe("disconnecting");
    const cleanup = await c.admin.select().from(jobs).where(eq(jobs.kind, "calendar.cleanup"));
    expect(cleanup.some((j) => (j.payload as { connectionId?: string }).connectionId === conn!.id && (j.payload as { deleteEvents?: boolean }).deleteEvents === true)).toBe(true);

    // what the organization owns stays, attributed to the placeholder
    const [kept] = await c.admin.select().from(tasks).where(eq(tasks.id, myTask.id));
    expect(kept).toMatchObject({ title: "Kept: authored task", createdBy: p.id });
    expect(await c.admin.select().from(comments).where(eq(comments.authorId, p.id))).toHaveLength(1);
    expect(await c.admin.select().from(attachments).where(eq(attachments.uploadedBy, p.id))).toHaveLength(1);
    const audit = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, p.O.org.id), eq(auditLogs.action, "account.erased")));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(p.email);

    // the e-mail address is free again
    await expect(c.admin.insert(users).values({ email: p.email, name: "Newcomer" })).resolves.toBeDefined();
    // a second erase attempt is refused (the session is gone)
    expect((await erase(p.client, { confirmEmail: p.email, password: PASSWORD })).status).toBe(401);
  });
});
