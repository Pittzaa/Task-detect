import { describe, expect, it } from "vitest";
import { ancestorsOf, wouldCreateCycle, type Edge } from "@/domain/graph";

const e = (task: string, prerequisite: string): Edge => ({ task, prerequisite });

describe("dependency cycle detection", () => {
  it("rejects self dependency", () => expect(wouldCreateCycle([], "a", "a")).toBe(true));
  it("rejects direct reversal", () => expect(wouldCreateCycle([e("a", "b")], "b", "a")).toBe(true));
  it("rejects transitive cycles", () => {
    const edges = [e("a", "b"), e("b", "c"), e("c", "d")];
    expect(wouldCreateCycle(edges, "d", "a")).toBe(true);
    expect(wouldCreateCycle(edges, "d", "b")).toBe(true);
  });
  it("accepts diamonds and independent branches", () => {
    const edges = [e("d", "b"), e("d", "c"), e("b", "a"), e("c", "a")];
    expect(wouldCreateCycle(edges, "e", "d")).toBe(false);
    expect(wouldCreateCycle(edges, "c", "b")).toBe(false);
  });
  it("is stable on already-cyclic bad data (terminates)", () => {
    expect(wouldCreateCycle([e("a", "b"), e("b", "a")], "x", "a")).toBe(false);
  });
  it("randomised: edges accepted one by one never produce a cycle", () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
    for (let round = 0; round < 50; round++) {
      const nodes = Array.from({ length: 8 }, (_, i) => "n" + i);
      const edges: Edge[] = [];
      for (let k = 0; k < 40; k++) {
        const a = nodes[rnd(8)]!, b = nodes[rnd(8)]!;
        if (!wouldCreateCycle(edges, a, b)) edges.push(e(a, b));
      }
      // verify acyclic by repeatedly removing nodes without prerequisites
      const left = new Set(nodes);
      let progress = true;
      while (progress) {
        progress = false;
        for (const n of [...left]) {
          if (!edges.some((x) => x.task === n && left.has(x.prerequisite))) { left.delete(n); progress = true; }
        }
      }
      expect(left.size).toBe(0);
    }
  });
});

describe("ancestorsOf", () => {
  it("walks to the root nearest-first and stops on malformed cycles", () => {
    const parents = new Map<string, string | null>([["c", "b"], ["b", "a"], ["a", null]]);
    expect(ancestorsOf(parents, "c")).toEqual(["b", "a"]);
    const bad = new Map<string, string | null>([["x", "y"], ["y", "x"]]);
    expect(ancestorsOf(bad, "x")).toEqual(["y"]);
  });
});
