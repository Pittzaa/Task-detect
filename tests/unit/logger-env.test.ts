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

describe("deployment tiers", () => {
  const base = { DATABASE_URL: "postgres://x" } as unknown as NodeJS.ProcessEnv;
  it("production requires the secrets, https and forbids the email sink", () => {
    expect(() => getEnv({ ...base, NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/BETTER_AUTH_SECRET/);
    const prod = { ...base, NODE_ENV: "production", BETTER_AUTH_SECRET: "x".repeat(40), APP_ENCRYPTION_KEY: "k", RESEND_API_KEY: "r", EMAIL_FROM: "a@b.c", CRON_SECRET: "c".repeat(20) } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv({ ...prod, APP_URL: "http://app.example" } as NodeJS.ProcessEnv)).toThrow(/APP_URL/);
    expect(() => getEnv({ ...prod, APP_URL: "https://app.example", EMAIL_SINK_FILE: "/tmp/x" } as NodeJS.ProcessEnv)).toThrow(/EMAIL_SINK_FILE/);
    expect(getEnv({ ...prod, APP_URL: "https://app.example" } as NodeJS.ProcessEnv).NODE_ENV).toBe("production");
  });
  it("a production build with no APP_ENV is still treated as production (cannot be relaxed by omission)", () => {
    expect(() => getEnv({ ...base, NODE_ENV: "production", EMAIL_SINK_FILE: "/tmp/x" } as NodeJS.ProcessEnv)).toThrow();
  });
  it("only the explicit e2e tier allows a production build over http with an email sink", () => {
    expect(getEnv({ ...base, NODE_ENV: "production", APP_ENV: "e2e", EMAIL_SINK_FILE: "/tmp/x" } as unknown as NodeJS.ProcessEnv).APP_ENV).toBe("e2e");
  });
  it("a production build running as a relaxed tier refuses to start unless it is served at localhost (APP_ENV cannot quietly switch the safeguards off)", () => {
    for (const tier of ["development", "test", "e2e"]) {
      expect(() => getEnv({ ...base, NODE_ENV: "production", APP_ENV: tier, APP_URL: "https://tasks.example.com" } as unknown as NodeJS.ProcessEnv), tier).toThrow(/APP_ENV/);
      expect(() => getEnv({ ...base, NODE_ENV: "production", APP_ENV: tier, APP_URL: "http://tasks.example.com" } as unknown as NodeJS.ProcessEnv), tier).toThrow(/APP_ENV/);
    }
    for (const url of ["http://localhost:3100", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(getEnv({ ...base, NODE_ENV: "production", APP_ENV: "e2e", APP_URL: url } as unknown as NodeJS.ProcessEnv).APP_ENV, url).toBe("e2e");
    }
    // plain development and test runs (no production build) are not restricted
    expect(getEnv({ ...base, NODE_ENV: "development", APP_URL: "https://my-tunnel.example.com" } as unknown as NodeJS.ProcessEnv).APP_URL).toBe("https://my-tunnel.example.com");
    // and the real tiers are unaffected
    const prod = { ...base, NODE_ENV: "production", APP_URL: "https://app.example", BETTER_AUTH_SECRET: "x".repeat(40), APP_ENCRYPTION_KEY: "k", RESEND_API_KEY: "r", EMAIL_FROM: "a@b.c", CRON_SECRET: "c".repeat(20) };
    expect(getEnv({ ...prod, APP_ENV: "staging" } as unknown as NodeJS.ProcessEnv).APP_ENV).toBe("staging");
  });
  it("blank values count as unset: optional ones are ignored, required ones still fail", () => {
    const prod = { ...base, NODE_ENV: "production", APP_URL: "https://app.example", BETTER_AUTH_SECRET: "x".repeat(40), APP_ENCRYPTION_KEY: "k", RESEND_API_KEY: "r", EMAIL_FROM: "a@b.c", CRON_SECRET: "c".repeat(20) };
    const env = getEnv({ ...prod, BLOB_READ_WRITE_TOKEN: "", GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "" } as unknown as NodeJS.ProcessEnv);
    expect(env.BLOB_READ_WRITE_TOKEN).toBeUndefined();
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(() => getEnv({ ...prod, RESEND_API_KEY: "" } as unknown as NodeJS.ProcessEnv)).toThrow(/RESEND_API_KEY/);
  });
  it("DIRECT_UPLOADS is an on/off switch and nothing else", () => {
    const prod = { DATABASE_URL: "postgres://x", NODE_ENV: "production", APP_URL: "https://app.example", BETTER_AUTH_SECRET: "x".repeat(40), APP_ENCRYPTION_KEY: "k", RESEND_API_KEY: "r", EMAIL_FROM: "a@b.c", CRON_SECRET: "c".repeat(20) };
    expect(getEnv(prod as unknown as NodeJS.ProcessEnv).DIRECT_UPLOADS).toBeUndefined();
    expect(getEnv({ ...prod, DIRECT_UPLOADS: "off" } as unknown as NodeJS.ProcessEnv).DIRECT_UPLOADS).toBe("off");
    expect(() => getEnv({ ...prod, DIRECT_UPLOADS: "maybe" } as unknown as NodeJS.ProcessEnv)).toThrow(/DIRECT_UPLOADS/);
  });
  it("staging is held to production rules", () => {
    expect(() => getEnv({ ...base, NODE_ENV: "production", APP_ENV: "staging" } as unknown as NodeJS.ProcessEnv)).toThrow(/BETTER_AUTH_SECRET/);
  });
});
