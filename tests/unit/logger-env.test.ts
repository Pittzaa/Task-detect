import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "@/lib/logger";
import { getEnv } from "@/config/env";

describe("logger redaction", () => {
  it("never writes secret fields", () => {
    let out = "";
    const sink = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } });
    const log = createLogger("info", sink);
    log.info({ password: "hunter2", user: { token: "tok-123", name: "ok" }, webhookUrl: "https://discord.test/hook/abc" }, "event");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("tok-123");
    expect(out).not.toContain("hook/abc");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain('"name":"ok"');
  });
});

describe("env validation", () => {
  it("fails with variable names but not values", () => {
    expect(() => getEnv({ NODE_ENV: "production", LOG_LEVEL: "loud" } as unknown as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL.*LOG_LEVEL|LOG_LEVEL.*DATABASE_URL/);
    try {
      getEnv({ LOG_LEVEL: "secret-value-xyz" } as unknown as NodeJS.ProcessEnv);
    } catch (e) {
      expect(String(e)).not.toContain("secret-value-xyz");
    }
  });

  it("accepts a valid configuration", () => {
    const env = getEnv({ DATABASE_URL: "postgres://x", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv);
    expect(env.LOG_LEVEL).toBe("info");
  });
});
