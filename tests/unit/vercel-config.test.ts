import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as { crons: { path: string; schedule: string }[] };

describe("Vercel cron configuration", () => {
  it("vercel.json (what is deployed) runs at most once a day, so it fits the Hobby plan", () => {
    const { crons } = read("vercel.json");
    expect(crons.length).toBeGreaterThan(0);
    for (const c of crons) {
      const [minute, hour] = c.schedule.split(/\s+/);
      // a plain minute and a plain hour: no *, lists, ranges or steps, so the expression matches exactly once per day
      expect(minute, c.schedule).toMatch(/^\d{1,2}$/);
      expect(hour, c.schedule).toMatch(/^\d{1,2}$/);
      expect(c.schedule.split(/\s+/)).toHaveLength(5);
    }
    expect(crons.map((c) => c.path)).toContain("/api/cron/tick");
  });

  it("the daily run is at 23:00 Thai time (Vercel reads the schedule in UTC)", () => {
    const tick = read("vercel.json").crons.find((c) => c.path === "/api/cron/tick")!;
    const [minute, hour] = tick.schedule.split(/\s+/).map(Number) as [number, number];
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.UTC(2026, 0, 15, hour, minute)));
    expect(local).toBe("23:00");
  });

  it("vercel.pro.json is the every-minute version for a paid plan, same endpoint", () => {
    const { crons } = read("vercel.pro.json");
    expect(crons).toEqual([{ path: "/api/cron/tick", schedule: "* * * * *" }]);
  });
});
