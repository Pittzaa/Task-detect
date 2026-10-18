import { mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
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
import { syncAttachments } from "@/ops/backup-attachments";
import { verifyAttachments } from "@/ops/verify-attachments";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const liveRoot = mkdtempSync(path.join(tmpdir(), "tt-live-"));
const backupRoot = mkdtempSync(path.join(tmpdir(), "tt-backup-"));
const live = createFsStore(liveRoot);
const backup = createFsStore(backupRoot);

let O: Awaited<ReturnType<typeof makeOrg>>;
let X: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
let xAdmin: { id: string };
beforeAll(async () => {
  O = await makeOrg(c.admin, "BackupOrg");
  X = await makeOrg(c.admin, "BackupOther");
  admin = await makeUser(c.admin, "ba");
  xAdmin = await makeUser(c.admin, "bx");
  await addMember(c.admin, O.org.id, admin.id, { role: "orgadmin" });
  await addMember(c.admin, X.org.id, xAdmin.id, { role: "orgadmin" });
});

async function upload(org: typeof O, user: { id: string }, name: string) {
  const t = await withTenant(c.app, { userId: user.id, orgId: org.org.id }, (s) => createTask(s, { projectId: org.project.id, title: name }));
  const a = await withTenant(c.app, { userId: user.id, orgId: org.org.id }, (s) => uploadAttachment(s, live, t.id, { name: `${name}.png`, bytes: PNG }));
  const [row] = await c.admin.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.id, a.id));
  return { id: a.id, key: row!.key };
}
const flip = (file: string) => { const b = readFileSync(file); b[b.length - 1] = b[b.length - 1]! ^ 0xff; writeFileSync(file, b); };

describe("backup and restore of attachment files", () => {
  const files: { id: string; key: string }[] = [];

  it("copies every referenced file into the second store, verified, and records a manifest; a second run copies nothing", async () => {
    for (const n of ["a1", "a2", "a3"]) files.push(await upload(O, admin, n));
    const other = await upload(X, xAdmin, "other-tenant");

    const first = await syncAttachments(c.app, live, backup, { orgId: O.org.id, manifest: true });
    expect(first.counts).toMatchObject({ copied: 3, present: 0, source_missing: 0, source_corrupt: 0, copy_failed: 0 });
    expect(first.bytesCopied).toBe(3 * PNG.length);
    expect(first.problems).toEqual([]);
    for (const f of files) expect(readFileSync(path.join(backupRoot, f.key))).toEqual(PNG);
    expect(await backup.get(other.key)).toBeNull(); // the other organization was not asked for
    expect(first.manifestKey).toMatch(/^manifests\/\d{8}T\d{6}Z$/);
    const manifest = JSON.parse(readFileSync(path.join(backupRoot, first.manifestKey!), "utf8"));
    expect(manifest.rows).toHaveLength(3);
    expect(manifest.rows[0]).toMatchObject({ outcome: "copied", size: PNG.length });

    const again = await syncAttachments(c.app, live, backup, { orgId: O.org.id });
    expect(again.counts).toMatchObject({ copied: 0, present: 3 });
    expect(again.manifestKey).toBeUndefined();
  });

  it("a dry run reports what it would do and writes nothing", async () => {
    const extra = await upload(O, admin, "dry");
    const r = await syncAttachments(c.app, live, backup, { orgId: O.org.id, dryRun: true, manifest: true });
    expect(r.counts.copied).toBe(1);
    expect(r.manifestKey).toBeUndefined();
    expect(await backup.get(extra.key)).toBeNull();
    files.push(extra);
    await syncAttachments(c.app, live, backup, { orgId: O.org.id });
  });

  it("never copies a damaged or missing source over a good backup, and says so", async () => {
    const bad = await upload(O, admin, "bad");
    const gone = await upload(O, admin, "gone");
    await syncAttachments(c.app, live, backup, { orgId: O.org.id }); // both are backed up while healthy
    flip(path.join(liveRoot, bad.key)); // same size, different bytes: only the hash notices
    await live.delete(gone.key);
    // wipe the backup copy of a third file so the damaged source would have to be copied, to prove it is not
    await backup.delete(bad.key);

    const r = await syncAttachments(c.app, live, backup, { orgId: O.org.id });
    // the damaged live file is reported and not propagated; the lost live file is no problem for the backup, which still holds a good copy
    expect(r.problems.map((p) => [p.attachmentId, p.outcome])).toEqual([[bad.id, "source_corrupt"]]);
    expect(await backup.get(bad.key)).toBeNull(); // the damaged bytes were NOT propagated
    expect(readFileSync(path.join(backupRoot, gone.key))).toEqual(PNG); // the good copy of the lost file is still there
    files.push(bad, gone);
  });

  it("restores after a disaster: files are copied back, and the database/storage verification is clean", async () => {
    // total loss of the live store
    for (const f of files) await live.delete(f.key);
    // the database says these files must exist; one of them ("bad") was never backed up healthy, so it stays reported
    const dry = await syncAttachments(c.app, backup, live, { orgId: O.org.id, dryRun: true });
    expect(dry.counts.copied).toBeGreaterThanOrEqual(4);

    const r = await syncAttachments(c.app, backup, live, { orgId: O.org.id });
    const lost = r.problems.map((p) => p.outcome);
    expect(lost).toEqual(["source_missing"]); // "bad" was never backed up healthy: honestly reported, not invented
    const check = await verifyAttachments(c.app, live, { orgId: O.org.id, hashes: true });
    expect(check.findings.map((f) => f.problem)).toEqual(["missing_object"]); // exactly the one that cannot be recovered
    expect(check.checkedHashes).toBe(check.rows - 1);
  });

  it("replaces a truncated copy in the destination, and --verify finds a same-size corruption", async () => {
    const f = files[0]!;
    truncateSync(path.join(backupRoot, f.key), 10);
    const r = await syncAttachments(c.app, live, backup, { orgId: O.org.id });
    expect(r.counts.copied).toBeGreaterThanOrEqual(1);
    expect(readFileSync(path.join(backupRoot, f.key))).toEqual(PNG);

    flip(path.join(backupRoot, f.key));
    expect((await syncAttachments(c.app, live, backup, { orgId: O.org.id })).counts.copied).toBe(0); // size matches: not noticed without --verify
    const verified = await syncAttachments(c.app, live, backup, { orgId: O.org.id, verify: true });
    expect(verified.counts.copied).toBe(1);
    expect(readFileSync(path.join(backupRoot, f.key))).toEqual(PNG);
  });

  it("never deletes: objects only the destination has are counted and kept", async () => {
    const keep = `orgs/${O.org.id}/tasks/${randomUUID()}/${randomUUID()}`;
    await backup.put(keep, PNG);
    const r = await syncAttachments(c.app, live, backup, { orgId: O.org.id });
    expect(r.destinationOnly).toBeGreaterThanOrEqual(1);
    expect(await backup.get(keep)).not.toBeNull();
  });
});
