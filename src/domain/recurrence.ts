import { z } from "zod";
import { addDays, daysInMonth, diffDays, weekdayOf } from "./time";
import { isValidDateOnly } from "./workflow";

/**
 * Recurrence rules. Occurrence dates are calendar dates, so DST never shifts them; only reminder
 * instants (computed from a date + zone elsewhere) are zone-sensitive.
 *  - daily:   every `interval` days from the start date
 *  - weekly:  every `interval` weeks (Monday-based weeks, anchored at the start date's week) on `weekdays` (0 = Sunday)
 *  - monthly: every `interval` months on `dayOfMonth`, clamped to the month's last day (31st -> Feb 28/29)
 */
export const ruleSchema = z.discriminatedUnion("freq", [
  z.object({ freq: z.literal("daily"), interval: z.number().int().min(1).max(365) }).strict(),
  z.object({ freq: z.literal("weekly"), interval: z.number().int().min(1).max(52), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).strict(),
  z.object({ freq: z.literal("monthly"), interval: z.number().int().min(1).max(24), dayOfMonth: z.number().int().min(1).max(31) }).strict(),
]);
export type RecurrenceRule = z.infer<typeof ruleSchema>;

export const seriesBoundsSchema = z
  .object({
    startDate: z.string().refine(isValidDateOnly),
    endDate: z.string().refine(isValidDateOnly).nullable().optional(),
    maxOccurrences: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, "endDate must not precede startDate");

const MAX_ITERATIONS = 5000;
const mondayOffset = (wd: number) => (wd + 6) % 7;

/** Every occurrence date from `startDate`, in order, never past `limitDate`. */
function* generate(rule: RecurrenceRule, startDate: string, limitDate: string): Generator<string> {
  if (rule.freq === "daily") {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const d = addDays(startDate, i * rule.interval);
      if (d > limitDate) return;
      yield d;
    }
  } else if (rule.freq === "weekly") {
    const days = [...new Set(rule.weekdays)].sort((a, b) => mondayOffset(a) - mondayOffset(b));
    const week0 = addDays(startDate, -mondayOffset(weekdayOf(startDate)));
    for (let k = 0; k < MAX_ITERATIONS; k++) {
      const weekStart = addDays(week0, k * rule.interval * 7);
      if (weekStart > limitDate) return;
      for (const wd of days) {
        const d = addDays(weekStart, mondayOffset(wd));
        if (d < startDate) continue;
        if (d > limitDate) return;
        yield d;
      }
    }
  } else {
    const [sy, sm] = startDate.split("-").map(Number) as [number, number];
    for (let k = 0; k < MAX_ITERATIONS; k++) {
      const total = sm - 1 + k * rule.interval;
      const y = sy + Math.floor(total / 12);
      const m = (total % 12) + 1;
      const day = Math.min(rule.dayOfMonth, daysInMonth(y, m));
      const d = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (d < startDate) continue;
      if (d > limitDate) return;
      yield d;
    }
  }
}

export interface OccurrenceWindow {
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  /** inclusive window of dates to return */
  from?: string;
  to: string;
}

/**
 * Occurrence dates inside [from, to]. The series' own end date and occurrence cap apply from the
 * very first occurrence, so asking for a later window returns exactly the same dates as slicing a
 * full run, which is what makes repeated/retried generation idempotent.
 */
export function occurrences(rule: RecurrenceRule, w: OccurrenceWindow): string[] {
  const limit = w.endDate && w.endDate < w.to ? w.endDate : w.to;
  const out: string[] = [];
  let n = 0;
  for (const d of generate(rule, w.startDate, limit)) {
    n++;
    if (w.maxOccurrences && n > w.maxOccurrences) break;
    if (!w.from || d >= w.from) out.push(d);
  }
  return out;
}

export function describeRule(rule: RecurrenceRule): string {
  if (rule.freq === "daily") return rule.interval === 1 ? "daily" : `every ${rule.interval} days`;
  if (rule.freq === "weekly") return `every ${rule.interval === 1 ? "" : rule.interval + " "}week(s) on ${rule.weekdays.join(",")}`;
  return `every ${rule.interval === 1 ? "" : rule.interval + " "}month(s) on day ${rule.dayOfMonth}`;
}

export { diffDays };
