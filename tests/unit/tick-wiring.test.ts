import { describe, expect, it } from "vitest";
import { USER_FACING_KINDS, registry } from "@/jobs/registry";
import { PERIODIC } from "@/jobs/tick";

describe("periodic work", () => {
  it("only names jobs that exist, once each", () => {
    const kinds = PERIODIC.map(([k]) => k);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const k of kinds) expect(Object.keys(registry), k).toContain(k);
  });

  it("queues the deadline e-mail every hour, and a request-driven run covers it", () => {
    expect(PERIODIC).toContainEqual(["deadline.email", 3600]);
    expect(USER_FACING_KINDS).toContain("deadline.email");
  });

  it("keeps digests with the cron: nothing request-driven queues them", () => {
    expect(USER_FACING_KINDS).not.toContain("digest.run");
  });
});
