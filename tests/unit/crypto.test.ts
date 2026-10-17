import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256Hex } from "@/lib/crypto";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");

describe("secret encryption", () => {
  it("round-trips and never contains the plaintext", () => {
    const env = encryptSecret("https://discord.com/api/webhooks/1/secret-token", k1, "row-1");
    expect(env).not.toContain("secret-token");
    expect(decryptSecret(env, [k1], "row-1")).toBe("https://discord.com/api/webhooks/1/secret-token");
  });
  it("uses a fresh nonce each time", () => {
    expect(encryptSecret("x", k1)).not.toBe(encryptSecret("x", k1));
  });
  it("is bound to its row: the same ciphertext moved to another row fails to decrypt", () => {
    const env = encryptSecret("secret", k1, "dest:A");
    expect(() => decryptSecret(env, [k1], "dest:B")).toThrow();
  });
  it("detects tampering", () => {
    const [v, iv, tag, ct] = encryptSecret("secret", k1, "a").split(".");
    const flipped = ct!.slice(0, -2) + (ct!.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret([v, iv, tag, flipped].join("."), [k1], "a")).toThrow();
    expect(() => decryptSecret([v, iv, tag!.slice(0, -2) + "AA", ct].join("."), [k1], "a")).toThrow();
  });
  it("supports key rotation: old ciphertext opens with [new, old]; wrong keys fail", () => {
    const env = encryptSecret("secret", k1, "a");
    expect(decryptSecret(env, [k2, k1], "a")).toBe("secret");
    expect(() => decryptSecret(env, [k2], "a")).toThrow();
  });
  it("rejects malformed envelopes and keys of the wrong size", () => {
    expect(() => decryptSecret("garbage", [k1])).toThrow();
    expect(() => decryptSecret("v2.a.b.c", [k1])).toThrow();
    expect(() => encryptSecret("x", Buffer.from("short").toString("base64"))).toThrow();
  });
});

describe("tokens and comparison", () => {
  it("tokens are long, URL-safe and unique", () => {
    const a = randomToken(), b = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
  it("hashes deterministically", () => expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  it("safeEqual compares by content and length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
