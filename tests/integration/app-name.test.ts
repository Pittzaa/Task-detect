import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { GET as contextGET } from "@/app/api/orgs/[orgId]/context/route";
import { POST as inviteRoute } from "@/app/api/orgs/[orgId]/invitations/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/orgs/[orgId]/settings/route";
import { withTenant } from "@/data/tenant";
import { createTask, setAssignees } from "@/data/tasks";
import { updateSettings } from "@/data/notifications";
import { auditLogs, organizations, tasks, users } from "@/db/schema";
import { DEFAULT_APP_NAME } from "@/domain/app-name";
import { deadlineEmail } from "@/jobs/handlers/deadline";
import { digestRun } from "@/jobs/handlers/digest";
import type { JobRow } from "@/jobs/queue";
import { forgetBrand, installationBrand } from "@/server/brand";
import { addMember, connect, makeOrg, makeUser, systemRoleId } from "./helpers";
import { Client, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { clearOutbox, makeJobCtx, pump } from "./jobs-helpers";

/**
 * The name the product goes by: chosen by the administrators in Settings -> General, and used on the pages and in every e-mail (subject, header,
 * footer, the sender's display name). Organizations are separate: one's name never shows in another's e-mail.
 */
const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);
const job = { orgId: null, payload: {} } as unknown as JobRow;
const manualJob = (orgId: string) => ({ orgId, payload: { manual: true } }) as unknown as JobRow;

type Org = Awaited<ReturnType<typeof makeOrg>>;
const setName = async (org: Org, name: string | null) => { await c.admin.update(organizations).set({ appName: name }).where(eq(organizations.id, org.org.id)); forgetBrand(); };

describe("the name, over HTTP", () => {
  let org: Org; let admin: Client; let member: Client;
  const P = () => ({ orgId: org.org.id });
  const url = () => `/api/orgs/${org.org.id}/settings`;
  const put = (body: unknown, who = admin) => who.route(settingsPUT as never, "PUT", url(), body, P());
  const stored = async () => (await c.admin.select({ n: organizations.appName }).from(organizations).where(eq(organizations.id, org.org.id)))[0]!.n;

  beforeAll(async () => {
    org = await makeOrg(c.admin, "BrandHttp");
    const mk = async (label: string, role: string) => {
      const { client, email } = await registerAndSignIn(app, label);
      const [row] = await c.admin.select().from(users).where(eq(users.email, email));
      await addMember(c.admin, org.org.id, row!.id, { role });
      return client;
    };
    admin = await mk("brandadm", "orgadmin");
    member = await mk("brandmem", "member");
  });

  it("starts as the default name, and only an administrator can read or change it", async () => {
    const got = await admin.route(settingsGET as never, "GET", url(), undefined, P());
    expect(await got.json()).toMatchObject({ appName: DEFAULT_APP_NAME, appNameIsDefault: true });
    expect((await member.route(settingsGET as never, "GET", url(), undefined, P())).status).toBe(403);
    expect((await put({ appName: "Hijack" }, member)).status).toBe(403);
    expect((await put({ appName: "Hijack" }, new Client(app.auth))).status).toBe(401);
    const evil = new Client(app.auth, "https://evil.example");
    evil.cookies = admin.cookies;
    expect((await put({ appName: "Hijack" }, evil)).status).toBe(403);
    expect(await stored()).toBeNull();
  });

  it("changes the name, tidies it, shows it to every member, and writes it to the audit log", async () => {
    const res = await put({ appName: "  Acme   Tasks " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appName: "Acme Tasks", appNameIsDefault: false });
    expect(await stored()).toBe("Acme Tasks");
    expect(await (await admin.route(settingsGET as never, "GET", url(), undefined, P())).json()).toMatchObject({ appName: "Acme Tasks", appNameIsDefault: false });
    // every member's copy of the name (the menu's label, the calendar option) is read from the organization's context
    for (const who of [admin, member]) {
      const ctx = (await (await who.route(contextGET as never, "GET", `/api/orgs/${org.org.id}/context`, undefined, P())).json()) as { org: { appName: string } };
      expect(ctx.org.appName).toBe("Acme Tasks");
    }
    const log = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, org.org.id), eq(auditLogs.action, "org.app_name_change")));
    expect(log).toHaveLength(1);
    expect(log[0]!.metadata).toEqual({ from: null, to: "Acme Tasks" });
    expect((await put({ appName: "ระบบงานของเรา" })).status).toBe(200); // Thai is a name like any other
    expect(await stored()).toBe("ระบบงานของเรา");
  });

  it("refuses names that could be misread in a header, a page or an address; the old name stays", async () => {
    for (const bad of ["<b>x</b>", 'say "hi"', "boss@bank.example", "😀 Tasks", "x".repeat(41), "-dash first", 7, true, ["a"]]) {
      const res = await put({ appName: bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect((await put({})).status).toBe(422); // nothing to change
    expect(await stored()).toBe("ระบบงานของเรา");
  });

  it("goes back to the default for an empty value or null", async () => {
    expect((await (await put({ appName: "" })).json())).toEqual({ appName: DEFAULT_APP_NAME, appNameIsDefault: true });
    expect(await stored()).toBeNull();
    await put({ appName: "Again" });
    expect((await (await put({ appName: null })).json())).toEqual({ appName: DEFAULT_APP_NAME, appNameIsDefault: true });
    expect(await stored()).toBeNull();
  });

  it("is also guarded by the database: an empty or too long name cannot be stored by any route", async () => {
    await expect(c.admin.update(organizations).set({ appName: "" }).where(eq(organizations.id, org.org.id))).rejects.toThrow();
    await expect(c.admin.update(organizations).set({ appName: "x".repeat(41) }).where(eq(organizations.id, org.org.id))).rejects.toThrow();
  });
});

describe("the name in the e-mails an organization sends", () => {
  let named: Org; let plain: Org; let adminClient: Client;
  const u: Record<string, { id: string; email: string }> = {};
  const NAME = "Bluebird Tasks";
  const as = <T>(k: string, org: Org, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: org.org.id }, fn);

  /** Every message must carry the name, in the header and the footer of both bodies, and must not mention the other name. */
  const expectBranded = (m: { subject: string; html: string; text: string; fromName?: string }, name: string, other: string) => {
    expect(m.subject, "subject").toContain(name);
    expect(m.html, "header").toContain(`>${name}<`);
    expect(m.html, "footer").toContain(`from ${name}.`);
    expect(m.text, "text").toContain(name);
    for (const part of [m.subject, m.html, m.text]) expect(part).not.toContain(other);
  };

  beforeAll(async () => {
    named = await makeOrg(c.admin, "BrandMail", { autoEmail: true });
    plain = await makeOrg(c.admin, "PlainMail", { autoEmail: true });
    await setName(named, NAME);
    for (const k of ["admin", "mgr", "mem", "digester"]) u[k] = await makeUser(c.admin, k);
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(inArray(users.id, [u.mem!.id, u.digester!.id]));
    for (const o of [named, plain]) {
      await addMember(c.admin, o.org.id, u.admin!.id, { role: "orgadmin" });
      await addMember(c.admin, o.org.id, u.mgr!.id, { role: "manager" });
      await addMember(c.admin, o.org.id, u.mem!.id, { role: "member" });
      await addMember(c.admin, o.org.id, u.digester!.id, { role: "member" });
    }
    await clearOutbox(c.admin);
    const { client, email } = await registerAndSignIn(app, "brandinviter");
    const [row] = await c.admin.select().from(users).where(eq(users.email, email));
    await addMember(c.admin, named.org.id, row!.id, { role: "orgadmin" });
    await addMember(c.admin, plain.org.id, row!.id, { role: "orgadmin" });
    adminClient = client;
  });

  it("a notification e-mail: subject, header, footer and sender", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await as("mgr", named, (s) => createTask(s, { projectId: named.project.id, title: "Brand me" }));
    await as("mgr", named, (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] }));
    await pump(ctx);
    const mail = email.sent.find((m) => m.to === u.mem!.email && m.subject.includes("Brand me"))!;
    expect(mail).toBeTruthy();
    expectBranded(mail, NAME, DEFAULT_APP_NAME);
    expect(mail.subject.startsWith(`[${NAME}] `)).toBe(true);
    expect(mail.fromName).toBe(NAME);
  });

  it("another organization on the same installation keeps its own name, and the default name leaves the configured sender name alone", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await as("mgr", plain, (s) => createTask(s, { projectId: plain.project.id, title: "Plain me" }));
    await as("mgr", plain, (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] }));
    await pump(ctx);
    const mail = email.sent.find((m) => m.to === u.mem!.email && m.subject.includes("Plain me"))!;
    expectBranded(mail, DEFAULT_APP_NAME, NAME);
    expect(mail.fromName).toBeUndefined();
  });

  it("the deadline e-mail", async () => {
    const t = await as("mgr", named, (s) => createTask(s, { projectId: named.project.id, title: "Overdue, branded", dueDate: "2026-01-05" }));
    await c.admin.update(tasks).set({ primaryAssigneeId: u.mem!.id }).where(eq(tasks.id, t.id));
    const { ctx, email } = makeJobCtx(c.app);
    ctx.now = () => new Date("2026-01-20T03:00:00Z");
    await deadlineEmail(ctx, manualJob(named.org.id));
    const mail = email.sent.find((m) => m.to === u.mem!.email)!;
    expect(mail.html).toContain("Overdue, branded");
    expectBranded(mail, NAME, DEFAULT_APP_NAME);
    expect(mail.subject.startsWith(`[${NAME}] Unfinished tasks`)).toBe(true);
    expect(mail.fromName).toBe(NAME);
  });

  it("the digest", async () => {
    await withTenant(c.app, { userId: u.digester!.id, orgId: named.org.id }, (s) => updateSettings(s, { digest: "daily", settings: [{ channel: "email", event: "task.assigned", enabled: false }] }));
    const { ctx, clock, email } = makeJobCtx(c.app);
    const t = await as("mgr", named, (s) => createTask(s, { projectId: named.project.id, title: "For the digest, branded" }));
    await as("mgr", named, (s) => setAssignees(s, t.id, { primary: u.digester!.id, co: [] }));
    clock.now = new Date("2026-03-10T03:00:00Z");
    await pump(ctx, 1);
    await digestRun(ctx, job);
    const mail = email.sent.find((m) => m.to === u.digester!.email && /digest/i.test(m.subject))!;
    expect(mail.html).toContain("For the digest, branded");
    expectBranded(mail, NAME, DEFAULT_APP_NAME);
    expect(mail.fromName).toBe(NAME);
  });

  it("an invitation, sent to someone outside the organization", async () => {
    const role = await systemRoleId(c.admin, "viewer");
    const address = `invitee-${Date.now()}@example.test`;
    const res = await adminClient.route(inviteRoute as never, "POST", `/api/orgs/${named.org.id}/invitations`, { email: address, roleId: role, locale: "en" }, { orgId: named.org.id });
    expect(res.status).toBe(201);
    const mail = app.email.sent.find((m) => m.to === address)!;
    expect(mail.subject).toBe(`You are invited to BrandMail on ${NAME}`);
    expectBranded(mail, NAME, DEFAULT_APP_NAME);
    expect(mail.fromName).toBe(NAME);
  });

  it("a change shows in the very next e-mail", async () => {
    await setName(named, "Greenfinch");
    const { ctx, email } = makeJobCtx(c.app);
    const t = await as("mgr", named, (s) => createTask(s, { projectId: named.project.id, title: "After the rename" }));
    await as("mgr", named, (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] }));
    await pump(ctx);
    const mail = email.sent.find((m) => m.to === u.mem!.email && m.subject.includes("After the rename"))!;
    expectBranded(mail, "Greenfinch", NAME);
    await setName(named, NAME);
  });
});

describe("the name where there is no organization to ask (sign-in pages, reset and verification e-mails)", () => {
  /** The shared database holds many organizations; this block needs a known universe, so the others are hidden for its duration (as registration.test.ts does). */
  let hidden: { id: string; deletedAt: Date | null }[] = [];
  let sole: Org;
  const mail = (to: string, pattern: RegExp) => [...app.email.sent].reverse().find((m) => m.to === to && pattern.test(m.subject))!;

  beforeAll(async () => {
    sole = await makeOrg(c.admin, "SoleBrand");
    hidden = (await c.admin.select({ id: organizations.id, deletedAt: organizations.deletedAt }).from(organizations)).filter((o) => o.id !== sole.org.id);
    await c.admin.update(organizations).set({ deletedAt: new Date() }).where(inArray(organizations.id, hidden.map((h) => h.id)));
    forgetBrand();
  });
  afterAll(async () => {
    for (const h of hidden) await c.admin.update(organizations).set({ deletedAt: h.deletedAt }).where(eq(organizations.id, h.id));
    await c.admin.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, sole.org.id));
    forgetBrand();
  });

  it("is the one organization's name when there is exactly one, and the default otherwise", async () => {
    expect(await installationBrand(c.app)).toBe(DEFAULT_APP_NAME); // one organization, no name chosen yet
    await setName(sole, "Bluebird");
    expect(await installationBrand(c.app)).toBe("Bluebird");
    const second = await makeOrg(c.admin, "SecondBrand");
    await setName(second, "Elsewhere");
    expect(await installationBrand(c.app)).toBe(DEFAULT_APP_NAME); // two: nobody's name is the installation's
    await c.admin.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, second.org.id));
    forgetBrand();
    expect(await installationBrand(c.app)).toBe("Bluebird");
    await setName(sole, null);
    expect(await installationBrand(c.app)).toBe(DEFAULT_APP_NAME);
  });

  it("is forgotten for every copy of the code in the process: a production build loads it once for the pages and once for the route that saves the name", async () => {
    vi.resetModules();
    const pages = await import("@/server/brand"); // the copy the sign-in page renders with
    vi.resetModules();
    const route = await import("@/server/brand"); // the copy the settings route calls forgetBrand on
    expect(route.installationBrand).not.toBe(pages.installationBrand); // really two copies
    await setName(sole, null);
    pages.forgetBrand();
    expect(await pages.installationBrand(c.app)).toBe(DEFAULT_APP_NAME); // remembered by the first copy
    await c.admin.update(organizations).set({ appName: "Kingfisher" }).where(eq(organizations.id, sole.org.id)); // not through setName: nothing is forgotten
    expect(await pages.installationBrand(c.app)).toBe(DEFAULT_APP_NAME); // still the remembered one
    route.forgetBrand();
    expect(await pages.installationBrand(c.app)).toBe("Kingfisher");
    await setName(sole, null);
  });

  it("the verification and the password-reset e-mails carry it, with the sender name", async () => {
    await setName(sole, "Bluebird");
    const { client, email } = await registerAndSignIn(app, "brandreset");
    const verify = mail(email, /Bluebird|ยืนยัน|Verify/i);
    expect(verify.subject).toContain("Bluebird");
    expect(verify.html).toContain(">Bluebird<");
    expect(verify.fromName).toBe("Bluebird");
    app.email.sent.length = 0;
    const res = await client.authCall("POST", "/request-password-reset", { email, redirectTo: "/reset" });
    expect(res.status).toBe(200);
    const reset = mail(email, /Bluebird/);
    expect(reset.subject).toContain("Bluebird");
    expect(reset.html).toContain(">Bluebird<");
    expect(reset.fromName).toBe("Bluebird");
    expect(reset.html).not.toContain(DEFAULT_APP_NAME);
  });

  it("with two organizations these e-mails use the default name, and the sender name the operator configured", async () => {
    const second = await makeOrg(c.admin, "ThirdBrand");
    await setName(second, "Elsewhere");
    try {
      const { email } = await registerAndSignIn(app, "brandtwo");
      const verify = mail(email, /.*/);
      expect(verify.html).toContain(`>${DEFAULT_APP_NAME}<`);
      expect(verify.html).not.toContain("Bluebird");
      expect(verify.html).not.toContain("Elsewhere");
      expect(verify.fromName).toBeUndefined();
    } finally {
      await c.admin.update(organizations).set({ deletedAt: new Date() }).where(and(eq(organizations.id, second.org.id), like(organizations.name, "ThirdBrand%")));
      forgetBrand();
    }
  });
});
