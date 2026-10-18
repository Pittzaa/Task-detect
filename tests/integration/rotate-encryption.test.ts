import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { createDestination, deleteDestination } from "@/data/integrations";
import { calendarConnections, integrationDestinations } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { rotateEncryptionKey } from "@/ops/rotate-encryption";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

const OLD = randomBytes(32).toString("base64");
const NEW = randomBytes(32).toString("base64");
const url = (t: string) => `https://discord.com/api/webhooks/123456789012345678/${t}`;

let O: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
let destId = "";
let calId = "";

beforeAll(async () => {
  O = await makeOrg(c.admin, "RotateOrg");
  admin = await makeUser(c.admin, "rot");
  await addMember(c.admin, O.org.id, admin.id, { role: "orgadmin" });
  const d = await withTenant(c.app, { userId: admin.id, orgId: O.org.id }, (s) => createDestination(s, { encryptionKeys: [OLD] }, { name: "Chan", webhookUrl: url("T".repeat(40)), projectId: O.project.id, events: ["task.assigned"] }));
  destId = d.id;
  const [conn] = await c.admin.insert(calendarConnections).values({ orgId: O.org.id, userId: admin.id, refreshTokenCiphertext: "x", scope: "s" }).returning({ id: calendarConnections.id });
  calId = conn!.id;
  await c.admin.update(calendarConnections).set({ refreshTokenCiphertext: encryptSecret("refresh-token-value", OLD, `cal:${calId}`) }).where(eq(calendarConnections.id, calId));
});

describe("encryption key rotation", () => {
  it("re-encrypts every secret under the new key, keeps the plaintext identical, and is idempotent", async () => {
    const before = await c.admin.select({ c: integrationDestinations.webhookCiphertext }).from(integrationDestinations).where(eq(integrationDestinations.id, destId));
    expect(() => decryptSecret(before[0]!.c, [NEW], `dest:${destId}`)).toThrow();

    const r = await rotateEncryptionKey(c.app, [NEW, OLD], { orgId: O.org.id });
    expect(r.failed).toEqual([]);
    expect(r.destinations).toBeGreaterThanOrEqual(1);
    expect(r.calendarConnections).toBeGreaterThanOrEqual(1);

    const [d] = await c.admin.select({ c: integrationDestinations.webhookCiphertext }).from(integrationDestinations).where(eq(integrationDestinations.id, destId));
    const [k] = await c.admin.select({ c: calendarConnections.refreshTokenCiphertext }).from(calendarConnections).where(eq(calendarConnections.id, calId));
    // now readable with the NEW key alone, i.e. the old key can be retired
    expect(decryptSecret(d!.c, [NEW], `dest:${destId}`)).toBe(url("T".repeat(40)));
    expect(decryptSecret(k!.c, [NEW], `cal:${calId}`)).toBe("refresh-token-value");
    expect(() => decryptSecret(d!.c, [OLD], `dest:${destId}`)).toThrow();

    const again = await rotateEncryptionKey(c.app, [NEW, OLD], { orgId: O.org.id });
    expect(again.destinations + again.calendarConnections).toBe(0);
    expect(again.alreadyCurrent).toBeGreaterThanOrEqual(2);
  });

  it("ignores deleted destinations (their secret is already destroyed) instead of reporting them as failures", async () => {
    const gone = await withTenant(c.app, { userId: admin.id, orgId: O.org.id }, (s) => createDestination(s, { encryptionKeys: [OLD] }, { name: "Gone", webhookUrl: url("G".repeat(40)), projectId: O.project.id, events: ["task.assigned"] }));
    await withTenant(c.app, { userId: admin.id, orgId: O.org.id }, (s) => deleteDestination(s, gone.id));
    const r = await rotateEncryptionKey(c.app, [NEW, OLD], { orgId: O.org.id });
    expect(r.failed.filter((f) => f.kind === "destination")).toEqual([]);
  });

  it("never overwrites a value it cannot decrypt; it reports it", async () => {
    const stranger = encryptSecret("lost", randomBytes(32).toString("base64"), `cal:${calId}`);
    await c.admin.update(calendarConnections).set({ refreshTokenCiphertext: stranger }).where(eq(calendarConnections.id, calId));
    const r = await rotateEncryptionKey(c.app, [NEW, OLD], { orgId: O.org.id });
    expect(r.failed).toEqual([{ kind: "calendar", id: calId }]);
    const [k] = await c.admin.select({ c: calendarConnections.refreshTokenCiphertext }).from(calendarConnections).where(eq(calendarConnections.id, calId));
    expect(k!.c).toBe(stranger); // untouched
  });

  it("refuses to run without a key", async () => {
    await expect(rotateEncryptionKey(c.app, [])).rejects.toThrow(/key is required/);
  });
});
