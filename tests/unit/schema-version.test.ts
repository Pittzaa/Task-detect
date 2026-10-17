import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPECTED_MIGRATIONS } from "@/config/schema-version";

describe("schema version", () => {
  it("EXPECTED_MIGRATIONS equals the number of migrations in the journal (bump it when you add one)", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: unknown[] };
    expect(EXPECTED_MIGRATIONS).toBe(journal.entries.length);
  });
});
