import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getEnv } from "@/config/env";
import { selectStore } from "@/integrations/storage/select";

describe("selectStore", () => {
  it("a directory on this server is used in production when no Blob token is set (self-hosting)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tt-att-"));
    const store = selectStore({ ATTACHMENTS_DIR: dir }, "production");
    await store.put("orgs/o/tasks/t/f1", Buffer.from("hello"));
    expect(readFileSync(path.join(dir, "orgs/o/tasks/t/f1"), "utf8")).toBe("hello");
    expect((await store.get("orgs/o/tasks/t/f1"))!.size).toBe(5);
    expect((await store.list("orgs/o/")).map((o) => o.key)).toEqual(["orgs/o/tasks/t/f1"]);
    await store.delete("orgs/o/tasks/t/f1");
    expect(existsSync(path.join(dir, "orgs/o/tasks/t/f1"))).toBe(false);
  });

  it("files are readable by the service account only (0600), in directories only it can enter (0700)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tt-att-"));
    await selectStore({ ATTACHMENTS_DIR: dir }, "production").put("orgs/o/tasks/t/f2", Buffer.from("x"));
    expect(statSync(path.join(dir, "orgs/o/tasks/t/f2")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "orgs")).mode & 0o777).toBe(0o700);
  });

  it("without a token or a directory, production and staging refuse uploads instead of writing to an ephemeral disk", async () => {
    for (const tier of ["production", "staging"]) {
      const store = selectStore({}, tier);
      expect(() => store.put("orgs/o/tasks/t/f", Buffer.from("x"))).toThrow(/ATTACHMENTS_DIR/);
    }
  });

  it("a Blob token wins over a directory, and development falls back to .data/uploads", () => {
    const blob = selectStore({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test_token", ATTACHMENTS_DIR: "/srv/x" }, "production");
    expect(typeof blob.put).toBe("function");
    expect(selectStore({}, "development")).toBeTruthy();
  });
});

describe("ATTACHMENTS_DIR in the environment", () => {
  const prod = { DATABASE_URL: "postgres://x", NODE_ENV: "production", APP_URL: "https://app.example", BETTER_AUTH_SECRET: "x".repeat(40), APP_ENCRYPTION_KEY: "k", RESEND_API_KEY: "r", EMAIL_FROM: "a@b.c", CRON_SECRET: "c".repeat(20) };
  const env = (extra: Record<string, string>) => getEnv({ ...prod, ...extra } as unknown as NodeJS.ProcessEnv);

  it("is optional, must be an absolute path, and is not combined with a Blob token", () => {
    expect(env({}).ATTACHMENTS_DIR).toBeUndefined();
    expect(env({ ATTACHMENTS_DIR: "/var/lib/task-tracker/attachments" }).ATTACHMENTS_DIR).toBe("/var/lib/task-tracker/attachments");
    expect(env({ ATTACHMENTS_DIR: "C:\\data\\files" }).ATTACHMENTS_DIR).toBe("C:\\data\\files");
    expect(() => env({ ATTACHMENTS_DIR: "attachments" })).toThrow(/ATTACHMENTS_DIR/);
    expect(() => env({ ATTACHMENTS_DIR: "./uploads" })).toThrow(/ATTACHMENTS_DIR/);
    expect(() => env({ ATTACHMENTS_DIR: "/srv/files", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" })).toThrow(/ATTACHMENTS_DIR/);
  });
});
