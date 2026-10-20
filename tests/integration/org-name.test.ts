import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { GET as contextGET } from "@/app/api/orgs/[orgId]/context/route";
import { POST as inviteRoute } from "@/app/api/orgs/[orgId]/invitations/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/orgs/[orgId]/settings/route";
import { listMyMemberships } from "@/data/account";
import { auditLogs, organizations, users } from "@/db/schema";
import { ORG_NAME_MAX } from "@/domain/org-name";
import { addMember, connect, makeOrg, systemRoleId } from "./helpers";
import { Client, makeAuthApp, registerAndSignIn } from "./auth-helpers";

/**
 * The organization's own name (the heading of the left menu): the administrators change it in Settings -> General, separately from the name of the
 * product. The code (slug) does not change, and one organization's administrators cannot rename another organization.
 */
const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

type Org = Awaited<ReturnType<typeof makeOrg>>;

describe("the organization's name, over HTTP", () => {
  let org: Org; let other: Org; let admin: Client; let member: Client; let memberId: string;
  const P = () => ({ orgId: org.org.id });
  const url = () => `/api/orgs/${org.org.id}/settings`;
  const put = (body: unknown, who = admin) => who.route(settingsPUT as never, "PUT", url(), body, P());
  const stored = async (o: Org = org) => (await c.admin.select({ n: organizations.name, slug: organizations.slug, app: organizations.appName }).from(organizations).where(eq(organizations.id, o.org.id)))[0]!;

  beforeAll(async () => {
    org = await makeOrg(c.admin, "RenameMe");
    other = await makeOrg(c.admin, "LeaveMeAlone");
    const mk = async (label: string, role: string) => {
      const { client, email } = await registerAndSignIn(app, label);
      const [row] = await c.admin.select().from(users).where(eq(users.email, email));
      await addMember(c.admin, org.org.id, row!.id, { role });
      return { client, id: row!.id, email };
    };
    const a = await mk("renameadm", "orgadmin");
    const m = await mk("renamemem", "member");
    admin = a.client; member = m.client; memberId = m.id;
  });

  it("an administrator reads it; a member, a stranger and another site cannot change it", async () => {
    const got = await admin.route(settingsGET as never, "GET", url(), undefined, P());
    expect(await got.json()).toMatchObject({ name: "RenameMe" });
    expect((await put({ name: "Hijack" }, member)).status).toBe(403);
    expect((await put({ name: "Hijack" }, new Client(app.auth))).status).toBe(401);
    const evil = new Client(app.auth, "https://evil.example");
    evil.cookies = admin.cookies;
    expect((await put({ name: "Hijack" }, evil)).status).toBe(403);
    expect((await stored()).n).toBe("RenameMe");
  });

  it("changes it and tidies it; the menu, the list of organizations and the invitation e-mails show it; the code and the product's name stay; the audit log says who", async () => {
    const before = await stored();
    const res = await put({ name: "  Siam   Design \n Co. " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Siam Design Co." });
    const after = await stored();
    expect(after).toEqual({ n: "Siam Design Co.", slug: before.slug, app: null });

    for (const who of [admin, member]) { // the context the left menu is drawn from
      const ctx = (await (await who.route(contextGET as never, "GET", `/api/orgs/${org.org.id}/context`, undefined, P())).json()) as { org: { name: string } };
      expect(ctx.org.name).toBe("Siam Design Co.");
    }
    expect((await listMyMemberships(c.app, memberId)).find((m) => m.org?.id === org.org.id)!.org!.name).toBe("Siam Design Co.");

    const role = await systemRoleId(c.admin, "viewer");
    const address = `rename-invitee-${Date.now()}@example.test`;
    const inv = await admin.route(inviteRoute as never, "POST", `/api/orgs/${org.org.id}/invitations`, { email: address, roleId: role, locale: "en" }, P());
    expect(inv.status).toBe(201);
    const mail = app.email.sent.find((m) => m.to === address)!;
    expect(mail.subject).toBe("You are invited to Siam Design Co. on Task Tracker");
    expect(mail.html).toContain("Siam Design Co.");
    expect(mail.html).not.toContain("RenameMe");

    const log = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, org.org.id), eq(auditLogs.action, "org.rename")));
    expect(log).toHaveLength(1);
    expect(log[0]!.metadata).toEqual({ from: "RenameMe", to: "Siam Design Co." });
    expect(log[0]!.actorUserId).not.toBeNull();

    expect((await put({ name: "บริษัท สยามดีไซน์ จำกัด (สำนักงานใหญ่)" })).status).toBe(200); // Thai, parentheses: a name like any other
    expect((await stored()).n).toBe("บริษัท สยามดีไซน์ จำกัด (สำนักงานใหญ่)");
  });

  it("refuses an empty name, invisible or control characters and a name that is too long; the old name stays", async () => {
    const keep = (await stored()).n;
    for (const bad of ["", "   ", "\n\t", "a\u0000b", "a\u0007b", "a​b", "a‮b", "x".repeat(ORG_NAME_MAX + 1), "ก".repeat(ORG_NAME_MAX + 1), 7, null, true, ["a"], { n: 1 }]) {
      const res = await put({ name: bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect((await put({})).status).toBe(422); // nothing to change
    expect((await stored()).n).toBe(keep);
    expect((await put({ name: "x".repeat(ORG_NAME_MAX) })).status).toBe(200); // the limit counts characters
    expect((await put({ name: "ก".repeat(ORG_NAME_MAX) })).status).toBe(200); // 80 Thai letters are 240 bytes and still fit
  });

  it("an administrator of one organization cannot rename another; its name and code stay as they were", async () => {
    const before = await stored(other);
    const res = await admin.route(settingsPUT as never, "PUT", `/api/orgs/${other.org.id}/settings`, { name: "Taken over" }, { orgId: other.org.id });
    expect(res.status).toBe(404); // someone who is not a member is told nothing about whether the organization exists
    expect(await stored(other)).toEqual(before);
  });

  it("a request that changes several settings is all or nothing: a refused name takes the product's name back with it", async () => {
    const before = await stored();
    const res = await put({ appName: "Atomic App", name: "" }); // the product's name is applied first, then the organization's name is refused
    expect(res.status).toBe(422);
    expect(await stored()).toEqual(before);
  });
});
