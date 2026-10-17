export interface StoredObject {
  stream: ReadableStream<Uint8Array>;
  size: number;
}

/** Private object storage. Keys are opaque and server-generated; objects are never publicly readable. */
export interface ObjectStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Used only by the orphan-cleanup job. */
  list(prefix: string): Promise<{ key: string; uploadedAt: Date }[]>;
}

export const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,300}$/;

export function assertSafeKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.includes("//")) throw new Error("unsafe storage key");
}
