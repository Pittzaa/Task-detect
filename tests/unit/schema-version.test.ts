import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPECTED_MIGRATIONS, migrationsStatus } from "@/config/schema-version";

describe("schema version", () => {
  it("EXPECTED_MIGRATIONS equals the number of migrations in the journal (bump it when you add one)", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: unknown[] };
    expect(EXPECTED_MIGRATIONS).toBe(journal.entries.length);
  });

  it("readiness: behind the build is a failure, equal is fine, ahead (an instant rollback) is reported but not down; an unreadable table is a failure", () => {
    expect(migrationsStatus(15, 15)).toEqual({ ok: true, detail: 15 });
    expect(migrationsStatus(14, 15)).toMatchObject({ ok: false });
    expect(migrationsStatus(16, 15)).toMatchObject({ ok: true });
    expect(String(migrationsStatus(16, 15).detail)).toContain("ahead");
    expect(migrationsStatus(-1, 15)).toMatchObject({ ok: false });
    expect(migrationsStatus(EXPECTED_MIGRATIONS).ok).toBe(true);
  });
});
