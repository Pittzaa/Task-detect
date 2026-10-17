import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES, defaultEnabled, digestPeriod, isHHMM, quietHoursEnd } from "@/domain/notifications";

describe("defaults", () => {
  it("in-app is on for every type; email only for action-needed types", () => {
    for (const t of NOTIFICATION_TYPES) expect(defaultEnabled("in_app", t)).toBe(true);
    expect(NOTIFICATION_TYPES.filter((t) => defaultEnabled("email", t))).toEqual(["task.assigned", "task.mentioned", "task.due_soon", "task.overdue"]);
  });
});

describe("quiet hours", () => {
  const BKK = "Asia/Bangkok";
  it("returns null outside the window and the end instant inside it (overnight window)", () => {
    expect(quietHoursEnd(new Date("2026-06-10T09:00:00Z"), BKK, "22:00", "07:00")).toBeNull(); // 16:00 local
    // 23:30 local on the 10th => ends 07:00 local on the 11th = 00:00Z on the 11th
    expect(quietHoursEnd(new Date("2026-06-10T16:30:00Z"), BKK, "22:00", "07:00")?.toISOString()).toBe("2026-06-11T00:00:00.000Z");
    // 03:00 local on the 11th => ends 07:00 the same local day = 00:00Z on the 11th
    expect(quietHoursEnd(new Date("2026-06-10T20:00:00Z"), BKK, "22:00", "07:00")?.toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });
  it("same-day windows and boundaries", () => {
    expect(quietHoursEnd(new Date("2026-06-10T05:00:00Z"), BKK, "12:00", "13:00")?.toISOString()).toBe("2026-06-10T06:00:00.000Z"); // 12:00 local, start inclusive
    expect(quietHoursEnd(new Date("2026-06-10T06:00:00Z"), BKK, "12:00", "13:00")).toBeNull(); // 13:00 local, end exclusive
  });
  it("follows the user's zone and DST", () => {
    // New York in summer (EDT, UTC-4): 23:00 local = 03:00Z next day; quiet until 07:00 local = 11:00Z
    expect(quietHoursEnd(new Date("2026-07-02T03:00:00Z"), "America/New_York", "22:00", "07:00")?.toISOString()).toBe("2026-07-02T11:00:00.000Z");
    // winter (EST, UTC-5): same local clock is one hour later in UTC
    expect(quietHoursEnd(new Date("2026-01-02T04:00:00Z"), "America/New_York", "22:00", "07:00")?.toISOString()).toBe("2026-01-02T12:00:00.000Z");
  });
  it("ignores malformed or empty windows", () => {
    expect(quietHoursEnd(new Date(), BKK, "25:00", "07:00")).toBeNull();
    expect(quietHoursEnd(new Date(), BKK, "08:00", "08:00")).toBeNull();
    expect(isHHMM("07:05")).toBe(true);
    expect(isHHMM("7:05")).toBe(false);
  });
});

describe("digest periods", () => {
  it("daily: not before 08:00 local, then one key per local date", () => {
    expect(digestPeriod(new Date("2026-06-10T00:30:00Z"), "Asia/Bangkok", "daily")).toBeNull(); // 07:30 local
    const p = digestPeriod(new Date("2026-06-10T01:30:00Z"), "Asia/Bangkok", "daily"); // 08:30 local
    expect(p?.key).toBe("daily:2026-06-10");
    expect(p?.startsAt.toISOString()).toBe("2026-06-10T01:00:00.000Z");
    expect(digestPeriod(new Date("2026-06-10T15:00:00Z"), "Asia/Bangkok", "daily")?.key).toBe("daily:2026-06-10");
  });
  it("weekly: keyed by the Monday of the local week; later days catch up; Monday before 08:00 still belongs to last week", () => {
    expect(digestPeriod(new Date("2026-06-08T01:30:00Z"), "Asia/Bangkok", "weekly")?.key).toBe("weekly:2026-06-08"); // Monday 08:30 local
    expect(digestPeriod(new Date("2026-06-10T05:00:00Z"), "Asia/Bangkok", "weekly")?.key).toBe("weekly:2026-06-08"); // Wednesday
    expect(digestPeriod(new Date("2026-06-07T05:00:00Z"), "Asia/Bangkok", "weekly")?.key).toBe("weekly:2026-06-01"); // Sunday belongs to the previous Monday's period
    expect(digestPeriod(new Date("2026-06-07T20:00:00Z"), "Asia/Bangkok", "weekly")).toBeNull(); // Monday 03:00 local, before send time
  });
  it("keys depend on the user's zone (same instant, different local day)", () => {
    const now = new Date("2026-06-10T20:00:00Z");
    expect(digestPeriod(now, "Asia/Bangkok", "daily")).toBeNull(); // 03:00 on the 11th local: before 08:00
    expect(digestPeriod(now, "America/New_York", "daily")?.key).toBe("daily:2026-06-10"); // 16:00 local
  });
});
