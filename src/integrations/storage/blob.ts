import { del, get, list, put } from "@vercel/blob";
import { assertSafeKey, type ObjectStore } from "./index";

/**
 * Vercel Blob in PRIVATE mode: every read goes through our authenticated route (the blob URL is not a
 * public link). Objects are stored as application/octet-stream so a misconfiguration can never cause
 * inline rendering; the real content type lives in the database.
 *
 * Verified against the SDK's type definitions (@vercel/blob 2.8.2) only. NOT exercised against a real
 * store in this repository's tests (no credentials). See docs/TESTING.md.
 */
export function createBlobStore(token: string): ObjectStore {
  return {
    async put(key, data) {
      assertSafeKey(key);
      await put(key, Buffer.from(data), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/octet-stream", token });
    },
    async get(key) {
      assertSafeKey(key);
      const res = await get(key, { access: "private", token, useCache: false });
      if (!res || res.statusCode !== 200) return null;
      return { stream: res.stream, size: res.blob.size };
    },
    async delete(key) {
      assertSafeKey(key);
      await del(key, { token });
    },
    async list(prefix) {
      const out: { key: string; uploadedAt: Date }[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, token, cursor, limit: 1000 });
        for (const b of page.blobs) out.push({ key: b.pathname, uploadedAt: b.uploadedAt });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}
