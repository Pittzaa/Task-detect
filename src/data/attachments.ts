import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { attachments, auditLogs, taskActivity } from "@/db/schema";
import { MAX_ATTACHMENTS_PER_TASK, MAX_DIRECT_UPLOAD_BYTES, MAX_UPLOAD_BYTES, detectFile, isDirectUploadKey, sanitizeFilename } from "@/domain/files";
import { sha256Hex } from "@/lib/crypto";
import { conflict, forbidden, notFound, validation } from "@/lib/errors";
import type { ObjectStore } from "@/integrations/storage";
import { can } from "@/authz/evaluate";
import { consumeRateLimit } from "@/server/rate-limit";
import { loadTask } from "./tasks";
import type { TenantSession } from "./tenant";

export async function uploadAttachment(s: TenantSession, store: ObjectStore, taskId: string, file: { name: string; bytes: Uint8Array }) {
  // The task row is locked so concurrent uploads count and insert one at a time (otherwise several could pass the cap check together).
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  if (!can(s.principal, "task.attach", scope)) throw forbidden({ permission: "task.attach" });
  await consumeRateLimit(s.tx as unknown as Db, `upload:${s.userId}`, 60, 20);

  if (file.bytes.length === 0) throw validation("File is empty");
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw validation("File is too large", { maxBytes: MAX_UPLOAD_BYTES });
  const detected = detectFile(file.bytes, file.name);
  if (!detected) throw validation("This file type is not allowed");

  const existing = await s.tx.select({ n: sql<number>`count(*)::int` }).from(attachments).where(and(eq(attachments.orgId, s.orgId), eq(attachments.taskId, task.id), isNull(attachments.deletedAt)));
  if ((existing[0]?.n ?? 0) >= MAX_ATTACHMENTS_PER_TASK) throw validation("Too many attachments on this task");

  const storageKey = `orgs/${s.orgId}/tasks/${task.id}/${randomUUID()}`;
  const [row] = await s.tx
    .insert(attachments)
    .values({
      orgId: s.orgId, taskId: task.id, uploadedBy: s.userId, storageKey, filename: sanitizeFilename(file.name),
      contentType: detected.contentType, sizeBytes: file.bytes.length, sha256: sha256Hex(file.bytes),
    })
    .returning({ id: attachments.id, filename: attachments.filename, contentType: attachments.contentType, sizeBytes: attachments.sizeBytes });
  // If the upload fails the transaction rolls back; if the commit later fails the orphaned object is
  // removed by the orphan-cleanup job.
  await store.put(storageKey, file.bytes);
  await s.tx.insert(taskActivity).values({ orgId: s.orgId, taskId: task.id, actorId: s.userId, type: "attachment_added", changes: { attachmentId: row!.id } });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "attachment.upload", targetType: "attachment", targetId: row!.id, metadata: { sizeBytes: row!.sizeBytes } });
  return row!;
}

async function attachmentCount(s: TenantSession, taskId: string): Promise<number> {
  const rows = await s.tx.select({ n: sql<number>`count(*)::int` }).from(attachments).where(and(eq(attachments.orgId, s.orgId), eq(attachments.taskId, taskId), isNull(attachments.deletedAt)));
  return rows[0]?.n ?? 0;
}

/**
 * Step 1 of a direct (browser -> Blob) upload: may this person put a file on this task, and is this the object name we allow?
 * Called while a short-lived upload token is being issued. The token is then bound to this exact name, size limit and a generic
 * content type, so it cannot be used for anything else. The file is NOT trusted until `finalizeDirectUpload` has inspected it.
 */
export async function authorizeDirectUpload(s: TenantSession, taskId: string, pathname: string) {
  const { task, scope } = await loadTask(s, taskId);
  if (!can(s.principal, "task.attach", scope)) throw forbidden({ permission: "task.attach" });
  if (!isDirectUploadKey(pathname, s.orgId, task.id)) throw validation("Invalid upload path");
  await consumeRateLimit(s.tx as unknown as Db, `upload-token:${s.userId}`, 60, 20);
  if ((await attachmentCount(s, task.id)) >= MAX_ATTACHMENTS_PER_TASK) throw validation("Too many attachments on this task");
  return { maximumSizeInBytes: MAX_DIRECT_UPLOAD_BYTES };
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); throw validation("File is too large", { maxBytes: max }); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Step 2: the browser says the upload finished. Nothing the browser claims is believed: the object is read back from the store,
 * its size and SHA-256 are computed here, its type is decided from its bytes, and the same permission, rate and count limits as a
 * normal upload apply. A file that fails any check is deleted from the store. Safe to call twice (it returns the existing record).
 */
export async function finalizeDirectUpload(s: TenantSession, store: ObjectStore, taskId: string, input: { key: string; name: string }) {
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  if (!can(s.principal, "task.attach", scope)) throw forbidden({ permission: "task.attach" });
  if (!isDirectUploadKey(input.key, s.orgId, task.id)) throw validation("Invalid upload path");

  const [known] = await s.tx.select({ id: attachments.id, taskId: attachments.taskId, uploadedBy: attachments.uploadedBy, filename: attachments.filename, contentType: attachments.contentType, sizeBytes: attachments.sizeBytes, deletedAt: attachments.deletedAt })
    .from(attachments).where(eq(attachments.storageKey, input.key));
  if (known) {
    if (known.taskId !== task.id || known.uploadedBy !== s.userId || known.deletedAt) throw conflict("This upload was already used");
    return { id: known.id, filename: known.filename, contentType: known.contentType, sizeBytes: known.sizeBytes };
  }
  await consumeRateLimit(s.tx as unknown as Db, `upload:${s.userId}`, 60, 20);
  if ((await attachmentCount(s, task.id)) >= MAX_ATTACHMENTS_PER_TASK) { await store.delete(input.key).catch(() => undefined); throw validation("Too many attachments on this task"); }

  const obj = await store.get(input.key);
  if (!obj) throw validation("The upload did not arrive. Try again");
  const reject = async (e: Error): Promise<never> => { await store.delete(input.key).catch(() => undefined); throw e; };
  let bytes: Buffer;
  try { bytes = await readCapped(obj.stream, MAX_DIRECT_UPLOAD_BYTES); } catch (e) { return reject(e as Error); }
  if (bytes.length === 0) return reject(validation("File is empty"));
  const detected = detectFile(bytes, input.name);
  if (!detected) return reject(validation("This file type is not allowed"));

  const [row] = await s.tx
    .insert(attachments)
    .values({ orgId: s.orgId, taskId: task.id, uploadedBy: s.userId, storageKey: input.key, filename: sanitizeFilename(input.name), contentType: detected.contentType, sizeBytes: bytes.length, sha256: sha256Hex(bytes) })
    .returning({ id: attachments.id, filename: attachments.filename, contentType: attachments.contentType, sizeBytes: attachments.sizeBytes });
  await s.tx.insert(taskActivity).values({ orgId: s.orgId, taskId: task.id, actorId: s.userId, type: "attachment_added", changes: { attachmentId: row!.id } });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "attachment.upload", targetType: "attachment", targetId: row!.id, metadata: { sizeBytes: row!.sizeBytes, direct: true } });
  return row!;
}

export async function listAttachments(s: TenantSession, taskId: string) {
  const { task } = await loadTask(s, taskId);
  return s.tx
    .select({ id: attachments.id, filename: attachments.filename, contentType: attachments.contentType, sizeBytes: attachments.sizeBytes, uploadedBy: attachments.uploadedBy, createdAt: attachments.createdAt })
    .from(attachments)
    .where(and(eq(attachments.orgId, s.orgId), eq(attachments.taskId, task.id), isNull(attachments.deletedAt)))
    .orderBy(asc(attachments.createdAt))
    .limit(MAX_ATTACHMENTS_PER_TASK);
}

/** Authorizes against the attachment's task at the moment of download; returns the stream and safe metadata. */
export async function openAttachment(s: TenantSession, store: ObjectStore, attachmentId: string) {
  const [a] = await s.tx.select().from(attachments).where(and(eq(attachments.orgId, s.orgId), eq(attachments.id, attachmentId), isNull(attachments.deletedAt)));
  if (!a) throw notFound();
  await loadTask(s, a.taskId); // NOT_FOUND unless the caller can read the task
  const obj = await store.get(a.storageKey);
  if (!obj) throw notFound();
  return { stream: obj.stream, filename: a.filename, contentType: a.contentType, size: a.sizeBytes };
}

export async function deleteAttachment(s: TenantSession, attachmentId: string) {
  const [a] = await s.tx.select().from(attachments).where(and(eq(attachments.orgId, s.orgId), eq(attachments.id, attachmentId), isNull(attachments.deletedAt)));
  if (!a) throw notFound();
  const { scope } = await loadTask(s, a.taskId);
  const ownAndAllowed = a.uploadedBy === s.userId && can(s.principal, "task.attach", scope);
  if (!ownAndAllowed && !can(s.principal, "task.delete", scope)) throw forbidden({ permission: "task.delete" });
  await s.tx.update(attachments).set({ deletedAt: new Date() }).where(eq(attachments.id, a.id));
  await s.tx.insert(taskActivity).values({ orgId: s.orgId, taskId: a.taskId, actorId: s.userId, type: "attachment_removed", changes: { attachmentId: a.id } });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "attachment.delete", targetType: "attachment", targetId: a.id });
}
