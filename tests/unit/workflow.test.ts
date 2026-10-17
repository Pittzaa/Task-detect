import { describe, expect, it } from "vitest";
import {
  TASK_STATUSES, canCompleteParent, completedAtFor, dependencyGate, isValidDateOnly, transitionKind, validateDateRange,
  type TaskStatus,
} from "@/domain/workflow";

describe("status transitions", () => {
  it("covers every ordered pair exactly once with a stable classification", () => {
    const table: Record<string, string> = {};
    for (const a of TASK_STATUSES) for (const b of TASK_STATUSES) table[`${a}->${b}`] = transitionKind(a, b);
    expect(table).toMatchInlineSnapshot(`
      {
        "blocked->blocked": "none",
        "blocked->cancelled": "normal",
        "blocked->done": "invalid",
        "blocked->progress": "normal",
        "blocked->review": "invalid",
        "blocked->todo": "normal",
        "cancelled->blocked": "invalid",
        "cancelled->cancelled": "none",
        "cancelled->done": "invalid",
        "cancelled->progress": "invalid",
        "cancelled->review": "invalid",
        "cancelled->todo": "reopen",
        "done->blocked": "invalid",
        "done->cancelled": "invalid",
        "done->done": "none",
        "done->progress": "reopen",
        "done->review": "invalid",
        "done->todo": "reopen",
        "progress->blocked": "normal",
        "progress->cancelled": "normal",
        "progress->done": "normal",
        "progress->progress": "none",
        "progress->review": "normal",
        "progress->todo": "normal",
        "review->blocked": "normal",
        "review->cancelled": "normal",
        "review->done": "normal",
        "review->progress": "normal",
        "review->review": "none",
        "review->todo": "invalid",
        "todo->blocked": "normal",
        "todo->cancelled": "normal",
        "todo->done": "invalid",
        "todo->progress": "normal",
        "todo->review": "invalid",
        "todo->todo": "none",
      }
    `);
  });

  it("cancelled is never treated as done", () => {
    expect(transitionKind("cancelled", "done")).toBe("invalid");
    expect(dependencyGate("progress", [{ id: "p", status: "cancelled" }]).allowed).toBe(false);
  });

  it("leaving a terminal status is always a reopen", () => {
    for (const from of ["done", "cancelled"] as TaskStatus[]) {
      for (const to of TASK_STATUSES) {
        const k = transitionKind(from, to);
        expect(["none", "reopen", "invalid"]).toContain(k);
      }
    }
  });
});

describe("dependency gate", () => {
  const prereq = (status: TaskStatus, id = "p") => ({ id, status });
  it("blocks starting, reviewing and finishing until every prerequisite is done", () => {
    for (const to of ["progress", "review", "done"] as TaskStatus[]) {
      expect(dependencyGate(to, [prereq("done", "a"), prereq("progress", "b")])).toEqual({ allowed: false, blockedBy: ["b"] });
      expect(dependencyGate(to, [prereq("done", "a"), prereq("done", "b")]).allowed).toBe(true);
    }
  });
  it("never blocks moving to todo, blocked or cancelled", () => {
    for (const to of ["todo", "blocked", "cancelled"] as TaskStatus[]) expect(dependencyGate(to, [prereq("todo")]).allowed).toBe(true);
  });
  it("no prerequisites means no gate", () => {
    expect(dependencyGate("done", []).allowed).toBe(true);
  });
});

describe("parent completion and completed date", () => {
  it("a parent can complete only when children are done or cancelled", () => {
    expect(canCompleteParent([])).toBe(true);
    expect(canCompleteParent([{ status: "done" }, { status: "cancelled" }])).toBe(true);
    expect(canCompleteParent([{ status: "done" }, { status: "review" }])).toBe(false);
  });
  it("completed_at is set on done, kept if already set, cleared otherwise", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const earlier = new Date("2026-01-01T00:00:00Z");
    expect(completedAtFor("done", null, now)).toEqual(now);
    expect(completedAtFor("done", earlier, now)).toEqual(earlier);
    expect(completedAtFor("progress", earlier, now)).toBeNull();
    expect(completedAtFor("cancelled", earlier, now)).toBeNull();
  });
});

describe("date-only validation", () => {
  it.each(["2026-02-28", "2024-02-29", "2026-12-31"])("accepts %s", (d) => expect(isValidDateOnly(d)).toBe(true));
  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-1-1", "26-01-01", "2026-01-01T00:00:00Z", "", "abc"])("rejects %s", (d) => expect(isValidDateOnly(d)).toBe(false));
  it("due must not precede start", () => {
    expect(validateDateRange("2026-03-01", "2026-03-01")).toBe(true);
    expect(validateDateRange("2026-03-02", "2026-03-01")).toBe(false);
    expect(validateDateRange(null, "2026-03-01")).toBe(true);
    expect(validateDateRange("2026-03-01", null)).toBe(true);
    expect(validateDateRange("2026-02-30", null)).toBe(false);
  });
});

describe("allowedTransitions (UI helper)", () => {
  it("offers only legal, permitted moves", async () => {
    const { allowedTransitions } = await import("@/domain/workflow");
    expect(allowedTransitions("todo", { canChange: true, canReopen: false }).sort()).toEqual(["blocked", "cancelled", "progress"]);
    expect(allowedTransitions("done", { canChange: true, canReopen: false })).toEqual([]);
    expect(allowedTransitions("done", { canChange: true, canReopen: true }).sort()).toEqual(["progress", "todo"]);
    expect(allowedTransitions("cancelled", { canChange: true, canReopen: true })).toEqual(["todo"]);
    expect(allowedTransitions("progress", { canChange: false, canReopen: true })).toEqual([]);
  });
});
