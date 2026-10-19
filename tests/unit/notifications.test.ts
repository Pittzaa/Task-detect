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
  it("daily: one key per local date from 08:00 local; before 08:00 the moment still belongs to yesterday's (catch-up)", () => {
    expect(digestPeriod(new Date("2026-06-10T00:30:00Z"), "Asia/Bangkok", "daily").key).toBe("daily:2026-06-09"); // 07:30 local
    const p = digestPeriod(new Date("2026-06-10T01:30:00Z"), "Asia/Bangkok", "daily"); // 08:30 local
    expect(p?.key).toBe("daily:2026-06-10");
    expect(p?.startsAt.toISOString()).toBe("2026-06-10T01:00:00.000Z");
    expect(digestPeriod(new Date("2026-06-10T15:00:00Z"), "Asia/Bangkok", "daily")?.key).toBe("daily:2026-06-10");
  });
  it("weekly: keyed by the Monday of the local week; later days catch up; Monday before 08:00 still belongs to last week", () => {
    expect(digestPeriod(new Date("2026-06-08T01:30:00Z"), "Asia/Bangkok", "weekly")?.key).toBe("weekly:2026-06-08"); // Monday 08:30 local
    expect(digestPeriod(new Date("2026-06-10T05:00:00Z"), "Asia/Bangkok", "weekly")?.key).toBe("weekly:2026-06-08"); // Wednesday
    expect(digestPeriod(new Date("2026-06-07T05:00:00Z"), "Asia/Bangkok", "weekly")?.key).toBe("weekly:2026-06-01"); // Sunday belongs to the previous Monday's period
    expect(digestPeriod(new Date("2026-06-07T20:00:00Z"), "Asia/Bangkok", "weekly").key).toBe("weekly:2026-06-01"); // Monday 03:00 local, before send time
  });
  it("keys depend on the user's zone (same instant, different local day)", () => {
    const now = new Date("2026-06-10T20:00:00Z");
    expect(digestPeriod(now, "Asia/Bangkok", "daily").key).toBe("daily:2026-06-10"); // 03:00 on the 11th local: still the 10th's period
    expect(digestPeriod(now, "America/New_York", "daily")?.key).toBe("daily:2026-06-10"); // 16:00 local
  });
  it("when the clocks change, a once-a-day run can skip one period or repeat one, never more (the digest's content window is wider than that, so nothing is left out)", () => {
    const keys = (from: string, days: number) => Array.from({ length: days }, (_, i) => digestPeriod(new Date(Date.parse(`${from}T16:00:00Z`) + i * 86_400_000), "America/Anchorage", "daily").key);
    expect(keys("2026-03-06", 5)).toEqual(["daily:2026-03-05", "daily:2026-03-06", "daily:2026-03-08", "daily:2026-03-09", "daily:2026-03-10"]); // spring: the 7th has no run of its own
    expect(keys("2026-10-30", 5)).toEqual(["daily:2026-10-30", "daily:2026-10-31", "daily:2026-10-31", "daily:2026-11-01", "daily:2026-11-02"]); // autumn: the 31st is seen twice
  });
  it("a scheduler that runs once a day at 16:00 UTC (23:00 Bangkok) serves every day in these zones (outside clock changes), Honolulu (06:00 local) included", () => {
    for (const tz of ["Asia/Bangkok", "Europe/London", "America/New_York", "Pacific/Honolulu", "Pacific/Kiritimati"]) {
      const keys = [10, 11, 12, 13].map((d) => digestPeriod(new Date(`2026-06-${d}T16:00:00Z`), tz, "daily").key);
      expect(new Set(keys).size, tz).toBe(4); // a different period on each run: none is skipped, none served twice
      const dates = keys.map((k) => k.slice("daily:".length));
      for (let i = 1; i < dates.length; i++) expect(Date.parse(dates[i]!) - Date.parse(dates[i - 1]!), tz).toBe(86_400_000); // consecutive days
    }
  });
});
