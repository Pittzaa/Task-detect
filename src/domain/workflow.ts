/**
 * Task workflow rules. Pure functions: no I/O, fully unit-tested. Stored status values are stable,
 * language-independent identifiers; translate only for display.
 */
export const TASK_STATUSES = ["todo", "progress", "review", "done", "cancelled", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Statuses a prerequisite must be in before its dependents may start. `cancelled` does NOT qualify. */
export const SATISFIES_DEPENDENCY: readonly TaskStatus[] = ["done"];

/** "Started" statuses are those a dependent may only enter once all prerequisites are done. */
export const REQUIRES_PREREQUISITES: readonly TaskStatus[] = ["progress", "review", "done"];

export const isTerminal = (s: TaskStatus) => s === "done" || s === "cancelled";

const FORWARD: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["progress", "blocked", "cancelled"],
  progress: ["review", "done", "blocked", "todo", "cancelled"],
  review: ["done", "progress", "blocked", "cancelled"],
  blocked: ["todo", "progress", "cancelled"],
  // Reopening (leaving a terminal status) is listed separately because it needs `task.reopen`.
  done: [],
  cancelled: [],
};

const REOPEN: Record<"done" | "cancelled", readonly TaskStatus[]> = {
  done: ["progress", "todo"],
  cancelled: ["todo"],
};

export type TransitionKind = "none" | "normal" | "reopen" | "invalid";

export function transitionKind(from: TaskStatus, to: TaskStatus): TransitionKind {
  if (from === to) return "none";
  if (isTerminal(from)) return REOPEN[from as "done" | "cancelled"].includes(to) ? "reopen" : "invalid";
  return FORWARD[from].includes(to) ? "normal" : "invalid";
}

export interface DependencyGate {
  allowed: boolean;
  /** Prerequisite ids that are not done. Empty when allowed. */
  blockedBy: string[];
}

/** Starting (or finishing) a task requires every live prerequisite to be done. */
export function dependencyGate(to: TaskStatus, prerequisites: readonly { id: string; status: TaskStatus }[]): DependencyGate {
  if (!REQUIRES_PREREQUISITES.includes(to)) return { allowed: true, blockedBy: [] };
  const open = prerequisites.filter((p) => !SATISFIES_DEPENDENCY.includes(p.status)).map((p) => p.id);
  return { allowed: open.length === 0, blockedBy: open };
}

/** A parent may be marked done only when all its live subtasks are done or cancelled. */
export function canCompleteParent(children: readonly { status: TaskStatus }[]): boolean {
  return children.every((c) => isTerminal(c.status));
}

/** Applies a status change to the derived `completedAt` field. */
export function completedAtFor(to: TaskStatus, previous: Date | null, now: Date): Date | null {
  if (to === "done") return previous ?? now;
  return null;
}

/** ISO calendar date (YYYY-MM-DD) validation, rejecting impossible dates such as 2026-02-30. */
export function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function validateDateRange(start: string | null | undefined, due: string | null | undefined): boolean {
  if (start && !isValidDateOnly(start)) return false;
  if (due && !isValidDateOnly(due)) return false;
  return !start || !due || due >= start; // ISO dates compare lexicographically
}
