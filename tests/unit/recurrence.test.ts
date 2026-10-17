import { describe, expect, it } from "vitest";
import { occurrences, ruleSchema, seriesBoundsSchema } from "@/domain/recurrence";

const r = (x: unknown) => ruleSchema.parse(x);

describe("recurrence rules", () => {
  it("every two weeks (Monday start)", () => {
    expect(occurrences(r({ freq: "weekly", interval: 2, weekdays: [1] }), { startDate: "2026-03-02", to: "2026-04-30" })).toEqual([
      "2026-03-02", "2026-03-16", "2026-03-30", "2026-04-13", "2026-04-27",
    ]);
  });

  it("selected weekdays: Mon/Wed/Fri weekly", () => {
    expect(occurrences(r({ freq: "weekly", interval: 1, weekdays: [5, 1, 3] }), { startDate: "2026-03-02", to: "2026-03-15" })).toEqual([
      "2026-03-02", "2026-03-04", "2026-03-06", "2026-03-09", "2026-03-11", "2026-03-13",
    ]);
  });

  it("starts mid-week without producing earlier days", () => {
    // start Wednesday 2026-03-04; Mon/Wed/Fri => Wed, Fri, then next week
    expect(occurrences(r({ freq: "weekly", interval: 1, weekdays: [1, 3, 5] }), { startDate: "2026-03-04", to: "2026-03-10" })).toEqual(["2026-03-04", "2026-03-06", "2026-03-09"]);
  });

  it("every second week with several weekdays skips the off weeks entirely", () => {
    expect(occurrences(r({ freq: "weekly", interval: 2, weekdays: [1, 4] }), { startDate: "2026-03-02", to: "2026-03-31" })).toEqual([
      "2026-03-02", "2026-03-05", "2026-03-16", "2026-03-19", "2026-03-30",
    ]);
  });

  it("Sunday belongs to the end of a Monday-based week", () => {
    expect(occurrences(r({ freq: "weekly", interval: 1, weekdays: [0] }), { startDate: "2026-03-02", to: "2026-03-16" })).toEqual(["2026-03-08", "2026-03-15"]);
  });

  it("daily with interval", () => {
    expect(occurrences(r({ freq: "daily", interval: 3 }), { startDate: "2026-02-27", to: "2026-03-08" })).toEqual(["2026-02-27", "2026-03-02", "2026-03-05", "2026-03-08"]);
  });

  it("monthly clamps to the last day of short months and recovers", () => {
    expect(occurrences(r({ freq: "monthly", interval: 1, dayOfMonth: 31 }), { startDate: "2026-01-15", to: "2026-05-31" })).toEqual([
      "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
    ]);
    expect(occurrences(r({ freq: "monthly", interval: 12, dayOfMonth: 29 }), { startDate: "2024-02-29", to: "2028-12-31" })).toEqual([
      "2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29",
    ]);
  });

  it("monthly skips a first date that falls before the start", () => {
    expect(occurrences(r({ freq: "monthly", interval: 1, dayOfMonth: 5 }), { startDate: "2026-03-10", to: "2026-05-31" })).toEqual(["2026-04-05", "2026-05-05"]);
  });

  it("honours end date and occurrence cap", () => {
    const rule = r({ freq: "daily", interval: 1 });
    expect(occurrences(rule, { startDate: "2026-03-01", endDate: "2026-03-03", to: "2026-12-31" })).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    expect(occurrences(rule, { startDate: "2026-03-01", maxOccurrences: 2, to: "2026-12-31" })).toEqual(["2026-03-01", "2026-03-02"]);
  });

  it("is idempotent across windows: incremental windows concatenate to the full run", () => {
    const rule = r({ freq: "weekly", interval: 1, weekdays: [1, 3] });
    const base = { startDate: "2026-03-02", maxOccurrences: 11 };
    const full = occurrences(rule, { ...base, to: "2026-12-31" });
    const a = occurrences(rule, { ...base, to: "2026-03-20" });
    const b = occurrences(rule, { ...base, from: "2026-03-21", to: "2026-04-10" });
    const c = occurrences(rule, { ...base, from: "2026-04-11", to: "2026-12-31" });
    expect([...a, ...b, ...c]).toEqual(full);
    expect(full).toHaveLength(11);
  });

  it("is unaffected by DST: dates are calendar dates (spring-forward weekend still yields consecutive days)", () => {
    expect(occurrences(r({ freq: "daily", interval: 1 }), { startDate: "2026-03-07", to: "2026-03-09" })).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
  });

  it("rejects malformed rules", () => {
    for (const bad of [
      { freq: "weekly", interval: 1, weekdays: [] }, { freq: "weekly", interval: 1, weekdays: [7] }, { freq: "daily", interval: 0 },
      { freq: "monthly", interval: 1, dayOfMonth: 32 }, { freq: "yearly", interval: 1 }, { freq: "daily", interval: 1, extra: true },
    ]) expect(ruleSchema.safeParse(bad).success).toBe(false);
    expect(seriesBoundsSchema.safeParse({ startDate: "2026-03-10", endDate: "2026-03-01" }).success).toBe(false);
    expect(seriesBoundsSchema.safeParse({ startDate: "2026-02-30" }).success).toBe(false);
  });

  it("stays bounded for pathological input", () => {
    const out = occurrences(r({ freq: "daily", interval: 1 }), { startDate: "2000-01-01", to: "2100-01-01" });
    expect(out.length).toBeLessThanOrEqual(5000);
  });
});
