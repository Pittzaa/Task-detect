import { describe, expect, it } from "vitest";
import { asEmailSchedule, emailRunAllowed, inDailyEmailWindow, nextDailyEmailAt } from "@/domain/email-schedule";

// Thai time is UTC+7 all year: 23:00 Thai = 16:00 UTC
const utc = (iso: string) => new Date(iso);

describe("daily e-mail window (23:00 to 03:59 Thai time)", () => {
  it("opens at 23:00 and closes before 04:00", () => {
    expect(inDailyEmailWindow(utc("2027-03-10T15:59:59Z"))).toBe(false); // 22:59:59
    expect(inDailyEmailWindow(utc("2027-03-10T16:00:00Z"))).toBe(true); // 23:00:00
    expect(inDailyEmailWindow(utc("2027-03-10T17:00:00Z"))).toBe(true); // 00:00 next day
    expect(inDailyEmailWindow(utc("2027-03-10T20:59:59Z"))).toBe(true); // 03:59:59
    expect(inDailyEmailWindow(utc("2027-03-10T21:00:00Z"))).toBe(false); // 04:00
    expect(inDailyEmailWindow(utc("2027-03-10T03:00:00Z"))).toBe(false); // 10:00
  });

  it("is the same on the days the clocks change elsewhere: Thai time has no daylight saving", () => {
    for (const d of ["2027-03-14", "2027-03-28", "2027-10-31", "2027-11-07"]) {
      expect(inDailyEmailWindow(utc(`${d}T15:59:00Z`)), d).toBe(false);
      expect(inDailyEmailWindow(utc(`${d}T16:00:00Z`)), d).toBe(true);
    }
  });
});

describe("nextDailyEmailAt", () => {
  it("is now inside the window", () => {
    for (const iso of ["2027-03-10T16:00:00Z", "2027-03-10T16:30:00Z", "2027-03-10T20:59:00Z"]) expect(nextDailyEmailAt(utc(iso)).toISOString(), iso).toBe(utc(iso).toISOString());
  });

  it("is the coming 23:00 Thai time outside it", () => {
    const at = (iso: string) => nextDailyEmailAt(utc(iso)).toISOString();
    expect(at("2027-03-10T03:00:00Z")).toBe("2027-03-10T16:00:00.000Z"); // 10:00 on the 10th -> 23:00 the same day
    expect(at("2027-03-10T15:59:59Z")).toBe("2027-03-10T16:00:00.000Z"); // one second before
    expect(at("2027-03-10T21:00:00Z")).toBe("2027-03-11T16:00:00.000Z"); // 04:00 on the 11th (window just closed) -> 23:00 on the 11th
    expect(at("2027-12-31T03:00:00Z")).toBe("2027-12-31T16:00:00.000Z");
    expect(at("2027-12-31T21:00:00Z")).toBe("2028-01-01T16:00:00.000Z"); // across a year end
    expect(at("2028-02-28T21:00:00Z")).toBe("2028-02-29T16:00:00.000Z"); // and a leap day
  });

  it("is never earlier than now and never more than a day away", () => {
    for (let h = 0; h < 48; h++) {
      const now = new Date(Date.UTC(2027, 5, 1, 0, 0, 0) + h * 1_800_000);
      const at = nextDailyEmailAt(now).getTime();
      expect(at).toBeGreaterThanOrEqual(now.getTime());
      expect(at - now.getTime()).toBeLessThan(86_400_000);
      expect(inDailyEmailWindow(new Date(at))).toBe(true);
    }
  });
});

describe("emailRunAllowed and asEmailSchedule", () => {
  it("instant mode always runs, daily mode only inside the window", () => {
    expect(emailRunAllowed("instant", utc("2027-03-10T03:00:00Z"))).toBe(true);
    expect(emailRunAllowed("daily", utc("2027-03-10T03:00:00Z"))).toBe(false);
    expect(emailRunAllowed("daily", utc("2027-03-10T16:00:00Z"))).toBe(true);
  });

  it("reads anything unknown as instant, the safe, pre-existing behaviour", () => {
    expect(asEmailSchedule("daily")).toBe("daily");
    for (const v of ["instant", "weekly", "", null, undefined, 3]) expect(asEmailSchedule(v)).toBe("instant");
  });
});
