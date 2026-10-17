import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** URL-safe random token (default 256 bits). Only its hash is ever stored. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function keyFrom(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes (base64)");
  return key;
}

/**
 * AES-256-GCM envelope: `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` binds the ciphertext to its
 * row (for example the owning org id) so a value copied to another row fails to decrypt.
 */
export function encryptSecret(plain: string, keyB64: string, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyB64), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Tries each key in order (current first) to support key rotation. */
export function decryptSecret(envelope: string, keysB64: string[], aad = ""): string {
  const [version, iv, tag, ct] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("unsupported secret format");
  for (const k of keysB64) {
    try {
      const d = createDecipheriv("aes-256-gcm", keyFrom(k), Buffer.from(iv, "base64url"));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    } catch {
      /* try next key */
    }
  }
  throw new Error("unable to decrypt secret");
}
