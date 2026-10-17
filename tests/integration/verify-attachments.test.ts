import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { uploadAttachment } from "@/data/attachments";
import { createTask } from "@/data/tasks";
import { attachments } from "@/db/schema";
import { createFsStore } from "@/integrations/storage/fs";
import { verifyAttachments } from "@/ops/verify-attachments";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const root = mkdtempSync(path.join(tmpdir(), "tt-verify-"));
const store = createFsStore(root);

let O: Awaited<ReturnType<typeof makeOrg>>;
let X: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
let xAdmin: { id: string };

beforeAll(async () => {
  O = await makeOrg(c.admin, "VerifyOrg");
  X = await makeOrg(c.admin, "VerifyOther");
  admin = await makeUser(c.admin, "va");
  xAdmin = await makeUser(c.admin, "vx");
  await addMember(c.admin, O.org.id, admin.id, { role: "orgadmin" });
  await addMember(c.admin, X.org.id, xAdmin.id, { role: "orgadmin" });
});

async function upload(org: typeof O, user: { id: string }, name: string) {
  const t = await withTenant(c.app, { userId: user.id, orgId: org.org.id }, (s) => createTask(s, { projectId: org.project.id, title: name }));
  const a = await withTenant(c.app, { userId: user.id, orgId: org.org.id }, (s) => uploadAttachment(s, store, t.id, { name: `${name}.png`, bytes: PNG }));
  const [row] = await c.admin.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.id, a.id));
  return { id: a.id, key: row!.key };
}

describe("database <-> object storage verification (used after a restore)", () => {
  it("reports nothing when everything is consistent", async () => {
    await upload(O, admin, "fine");
    const r = await verifyAttachments(c.app, store, { orgId: O.org.id, hashes: true });
    expect(r.findings).toEqual([]);
    expect(r.rows).toBeGreaterThanOrEqual(1);
    expect(r.checkedHashes).toBe(r.rows);
  });

  it("finds a missing object, corrupted bytes and a wrong size, per organization, without touching anything", async () => {
    const missing = await upload(O, admin, "missing");
    const flipped = await upload(O, admin, "flipped");
    const resized = await upload(O, admin, "resized");
    const other = await upload(X, xAdmin, "other-tenant");
    await store.delete(missing.key);
    const tampered = Buffer.from(PNG); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    writeFileSync(path.join(root, flipped.key), tampered); // same length, different bytes
    writeFileSync(path.join(root, resized.key), Buffer.concat([PNG, Buffer.from("x")]));

    const quick = await verifyAttachments(c.app, store, { orgId: O.org.id });
    expect(quick.findings.map((f) => [f.attachmentId, f.problem]).sort()).toEqual([[missing.id, "missing_object"], [resized.id, "size_mismatch"]].sort());

    const full = await verifyAttachments(c.app, store, { orgId: O.org.id, hashes: true });
    expect(full.findings.map((f) => [f.attachmentId, f.problem]).sort()).toEqual([[flipped.id, "hash_mismatch"], [missing.id, "missing_object"], [resized.id, "size_mismatch"]].sort());

    // another tenant is only examined when asked for, and its health is reported separately
    const xOnly = await verifyAttachments(c.app, store, { orgId: X.org.id, hashes: true });
    expect(xOnly.findings).toEqual([]);
    expect(await store.get(other.key)).not.toBeNull();
    // nothing was modified
    expect(await store.get(flipped.key)).not.toBeNull();
  });

  it("counts objects that no row references", async () => {
    await store.put(`orgs/${O.org.id}/tasks/${randomUUID()}/${randomUUID()}`, PNG);
    const r = await verifyAttachments(c.app, store, { orgId: O.org.id });
    expect(r.unreferencedObjects).toBeGreaterThanOrEqual(1);
  });
});
