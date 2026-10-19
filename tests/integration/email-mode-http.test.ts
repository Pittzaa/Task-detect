import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { GET as settingsGET } from "@/app/api/orgs/[orgId]/notification-settings/route";
import { GET as orgSettingsGET, PUT as orgSettingsPUT } from "@/app/api/orgs/[orgId]/settings/route";
import { GET as emailsGET, POST as emailsPOST } from "@/app/api/orgs/[orgId]/notification-emails/route";
import { auditLogs, jobs, notifications, users } from "@/db/schema";
import { setAssignees, createTask } from "@/data/tasks";
import { withTenant } from "@/data/tenant";
import { addMember, connect, makeOrg } from "./helpers";
import { Client, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { clearOutbox, pump } from "./jobs-helpers";

/** The manual e-mail endpoints as a browser reaches them: authentication, permission, mode, throttling. */
const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

describe("notification e-mail HTTP API (manual mode)", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let admin: Client; let mem: Client; let memId: string; let adminId: string;
  const P = () => ({ orgId: O.org.id });
  const url = () => `/api/orgs/${O.org.id}/notification-emails`;

  beforeAll(async () => {
    O = await makeOrg(c.admin, "MailHttpOrg", { autoEmail: false });
    const mk = async (label: string, role: string) => {
      const { client, email } = await registerAndSignIn(app, label);
      const [u] = await c.admin.select().from(users).where(eq(users.email, email));
      await addMember(c.admin, O.org.id, u!.id, { role });
      return { client, id: u!.id };
    };
    const a = await mk("mhadm", "orgadmin"); admin = a.client; adminId = a.id;
    const m = await mk("mhmem", "member"); mem = m.client; memId = m.id;
    await clearOutbox(c.admin);
    // one waiting e-mail: the admin assigns a task to the member, the background work runs in manual mode
    const t = await withTenant(c.app, { userId: adminId, orgId: O.org.id }, (s) => createTask(s, { projectId: O.project.id, title: "Http mail" }));
    await withTenant(c.app, { userId: adminId, orgId: O.org.id }, (s) => setAssignees(s, t.id, { primary: memId, co: [] }));
    await pump(app.runtime.jobContext() as never);
  });

  it("answers 401 without a session and 403 to someone who cannot manage settings", async () => {
    const anon = new Client(app.auth);
    expect((await anon.route(emailsGET as never, "GET", url(), undefined, P())).status).toBe(401);
    expect((await anon.route(emailsPOST as never, "POST", url(), undefined, P())).status).toBe(401);
    expect((await mem.route(emailsGET as never, "GET", url(), undefined, P())).status).toBe(403);
    expect((await mem.route(emailsPOST as never, "POST", url(), undefined, P())).status).toBe(403);
  });

  it("refuses a cross-origin POST", async () => {
    const evil = new Client(app.auth, "https://evil.example");
    evil.cookies = admin.cookies;
    expect((await evil.route(emailsPOST as never, "POST", url(), undefined, P())).status).toBe(403);
  });

  it("tells an administrator how many are waiting; every member sees on their own settings whether e-mail is automatic", async () => {
    const r = await admin.route(emailsGET as never, "GET", url(), undefined, P());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ waiting: 1 });
    const own = async () => ((await (await mem.route(settingsGET as never, "GET", `/api/orgs/${O.org.id}/notification-settings`, undefined, P())).json()) as { autoEmail: boolean }).autoEmail;
    expect(await own()).toBe(false);
    const put = (body: unknown, who = admin) => who.route(orgSettingsPUT as never, "PUT", `/api/orgs/${O.org.id}/settings`, body, P());
    expect((await put({ autoEmail: true }, mem)).status).toBe(403);
    expect(await own()).toBe(false);
    expect((await put({ autoEmail: "yes" })).status).toBe(422);
    const on = await put({ autoEmail: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ autoEmail: true });
    try {
      expect(await own()).toBe(true);
      const got = await admin.route(orgSettingsGET as never, "GET", `/api/orgs/${O.org.id}/settings`, undefined, P());
      expect(await got.json()).toMatchObject({ autoEmail: true, registrationOpen: true });
      // both switches in one request
      const both = await put({ autoEmail: false, registrationOpen: true });
      expect(await both.json()).toEqual({ registrationOpen: true, autoEmail: false });
    } finally { await put({ autoEmail: false }); }
    expect(await own()).toBe(false);
  });

  it("sends on request, once, and throttles repeated presses", async () => {
    const r = await admin.route(emailsPOST as never, "POST", url(), undefined, P());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ queued: 1, more: false });
    const [n] = await c.admin.select().from(notifications).where(and(eq(notifications.orgId, O.org.id), eq(notifications.userId, memId)));
    expect(await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `email:${n!.id}`))).toHaveLength(1);
    expect(await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "notification.send_waiting_emails")))).toHaveLength(1);
    expect(((await (await admin.route(emailsGET as never, "GET", url(), undefined, P())).json()) as { waiting: number }).waiting).toBe(0);

    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await admin.route(emailsPOST as never, "POST", url(), undefined, P())).status);
    expect(codes.at(-1)).toBe(429); // six presses a minute at most (one was used above)
    expect(codes[0]).toBe(200);
  });
});
