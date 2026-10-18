import { api } from "../api";

/**
 * Sends a file larger than a serverless request body allows straight to Vercel Blob, then asks our server to inspect and register it.
 * The server issues the upload token (after checking the session and permission) and, afterwards, reads the stored object back
 * itself: nothing this function reports is trusted. The Blob client is loaded only when a large file is actually chosen.
 */
export async function uploadLargeFile(o: { orgId: string; taskId: string; file: File; onProgress: (pct: number) => void }): Promise<void> {
  const { upload } = await import("@vercel/blob/client");
  const base = `/api/orgs/${o.orgId}/tasks/${o.taskId}/attachments`;
  const key = `orgs/${o.orgId}/tasks/${o.taskId}/${crypto.randomUUID()}`;
  await upload(key, o.file, {
    access: "private",
    handleUploadUrl: `${base}/direct`,
    contentType: "application/octet-stream",
    multipart: o.file.size > 8_000_000,
    onUploadProgress: (e) => o.onProgress(e.percentage),
  });
  await api(`${base}/direct/complete`, { method: "POST", body: { key, name: o.file.name } });
}
