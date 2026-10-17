import { describe, expect, it } from "vitest";
import { addDays, dateInZone, diffDays, formatDate, formatInstant, isValidTimeZone, localToUtc, reminderInstant, todayIn, tzOffsetMinutes, weekdayOf } from "@/domain/time";

const iso = (d: Date) => d.toISOString();

describe("time zones", () => {
  it("validates IANA names", () => {
    expect(isValidTimeZone("Asia/Bangkok")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("Bangkok has no DST: UTC+7 all year", () => {
    expect(tzOffsetMinutes(Date.UTC(2026, 0, 1), "Asia/Bangkok")).toBe(420);
    expect(tzOffsetMinutes(Date.UTC(2026, 6, 1), "Asia/Bangkok")).toBe(420);
    expect(iso(localToUtc("2026-07-01", 9, 0, "Asia/Bangkok"))).toBe("2026-07-01T02:00:00.000Z");
  });

  it("New York: 09:00 local is 14:00Z in winter and 13:00Z in summer", () => {
    expect(iso(localToUtc("2026-01-15", 9, 0, "America/New_York"))).toBe("2026-01-15T14:00:00.000Z");
    expect(iso(localToUtc("2026-07-01", 9, 0, "America/New_York"))).toBe("2026-07-01T13:00:00.000Z");
  });

  it("spring-forward gap resolves forward (02:30 does not exist on 2026-03-08 in New York)", () => {
    expect(iso(localToUtc("2026-03-08", 2, 30, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z"); // = 03:30 EDT
    expect(iso(localToUtc("2026-03-29", 1, 30, "Europe/London"))).toBe("2026-03-29T01:30:00.000Z"); // = 02:30 BST
  });

  it("fall-back overlap resolves to the first occurrence", () => {
    expect(iso(localToUtc("2026-11-01", 1, 30, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z"); // EDT, first
    expect(iso(localToUtc("2026-10-25", 1, 30, "Europe/London"))).toBe("2026-10-25T00:30:00.000Z"); // BST, first
  });

  it("handles half-hour DST (Lord Howe)", () => {
    expect(iso(localToUtc("2026-01-15", 9, 0, "Australia/Lord_Howe"))).toBe("2026-01-14T22:00:00.000Z"); // +11
    expect(iso(localToUtc("2026-07-15", 9, 0, "Australia/Lord_Howe"))).toBe("2026-07-14T22:30:00.000Z"); // +10:30
  });

  it("round-trips: converting a local wall time and reading it back in the zone gives the same wall time", () => {
    for (const tz of ["America/New_York", "Europe/London", "Asia/Bangkok", "Australia/Lord_Howe", "Pacific/Auckland"]) {
      for (const date of ["2026-01-10", "2026-03-20", "2026-06-30", "2026-10-31", "2026-12-25"]) {
        const inst = localToUtc(date, 9, 0, tz);
        expect(dateInZone(inst, tz), `${tz} ${date}`).toBe(date);
        const off = tzOffsetMinutes(inst.getTime(), tz);
        expect(new Date(inst.getTime() + off * 60000).toISOString().slice(11, 16)).toBe("09:00");
      }
    }
  });

  it("reminders keep 09:00 local across a DST change (one day apart differ by 23h in UTC terms)", () => {
    const a = reminderInstant("2026-03-09", 2, "America/New_York"); // Sat 03-07 09:00 EST
    const b = reminderInstant("2026-03-09", 1, "America/New_York"); // Sun 03-08 09:00 EDT
    expect(iso(a)).toBe("2026-03-07T14:00:00.000Z");
    expect(iso(b)).toBe("2026-03-08T13:00:00.000Z");
    expect((b.getTime() - a.getTime()) / 3_600_000).toBe(23);
  });

  it("'today' depends on the zone: 20:00Z is already tomorrow in Bangkok and still today in New York", () => {
    const now = new Date("2026-05-10T20:00:00Z");
    expect(todayIn("Asia/Bangkok", now)).toBe("2026-05-11");
    expect(todayIn("America/New_York", now)).toBe("2026-05-10");
    expect(todayIn("UTC", now)).toBe("2026-05-10");
  });
});

describe("date arithmetic", () => {
  it("adds across months, years and leap days", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(diffDays("2026-03-10", "2026-03-01")).toBe(9);
  });
  it("knows weekdays", () => {
    expect(weekdayOf("2026-03-08")).toBe(0); // Sunday
    expect(weekdayOf("2026-03-09")).toBe(1);
  });
});

describe("formatting", () => {
  it("renders Thai dates in the Buddhist Era and English in Gregorian", () => {
    expect(formatDate("2026-03-09", "th")).toContain("2569");
    expect(formatDate("2026-03-09", "en")).toContain("2026");
    expect(formatDate("2026-03-09", "th")).toMatch(/[฀-๿]/);
  });
  it("formats instants in the user's zone", () => {
    const i = new Date("2026-05-10T20:00:00Z");
    expect(formatInstant(i, "en", "Asia/Bangkok", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).toBe("03:00");
    expect(formatInstant(i, "en", "America/New_York", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).toBe("16:00");
  });
});
