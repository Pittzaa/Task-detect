/** Edge `task -> prerequisite`: `task` depends on `prerequisite`. */
export interface Edge {
  task: string;
  prerequisite: string;
}

/**
 * Would adding "task depends on prerequisite" create a cycle? True when `task` is already reachable
 * by walking prerequisites upstream from `prerequisite` (or they are the same task).
 */
export function wouldCreateCycle(edges: readonly Edge[], task: string, prerequisite: string): boolean {
  if (task === prerequisite) return true;
  const up = new Map<string, string[]>();
  for (const e of edges) (up.get(e.task) ?? up.set(e.task, []).get(e.task)!).push(e.prerequisite);
  const seen = new Set<string>();
  const stack = [prerequisite];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === task) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(up.get(cur) ?? []));
  }
  return false;
}

/** All ancestors of a node in a parent map (child -> parent), nearest first. Stops on malformed cycles. */
export function ancestorsOf(parentOf: ReadonlyMap<string, string | null>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = parentOf.get(id) ?? null;
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return out;
}

export const MAX_SUBTASK_DEPTH = 5;
