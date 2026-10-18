import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/data/tenant";
import { createTask, listTasks } from "@/data/tasks";
import { searchAll } from "@/data/search";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

let O: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: admin.id, orgId: O.org.id }, fn);

beforeAll(async () => {
  O = await makeOrg(c.admin, "QualityOrg");
  admin = await makeUser(c.admin, "q");
  await addMember(c.admin, O.org.id, admin.id, { role: "orgadmin" });
});

describe("paging", () => {
  it("pages through many tasks that tie on every sort key without duplicates or gaps", async () => {
    const made: string[] = [];
    for (let i = 0; i < 130; i++) made.push((await run((s) => createTask(s, { projectId: O.project.id, title: "Tie", dueDate: "2031-01-01", priority: "high" }))).id);
    for (const sort of ["due", "priority", "created", "updated", "title"] as const) {
      const seen: string[] = [];
      for (let offset = 0; offset < 200; offset += 50) {
        const page = await run((s) => listTasks(s, { sort, limit: 50, offset, q: "Tie" } as never));
        seen.push(...page.items.map((t) => t.id));
        if (!page.hasMore) break;
      }
      expect(new Set(seen).size, `${sort}: duplicates`).toBe(seen.length);
      expect(seen.length, `${sort}: missing`).toBe(made.length);
    }
  });
});

describe("search text handling", () => {
  it("treats % and _ as ordinary characters, not wildcards", async () => {
    await run((s) => createTask(s, { projectId: O.project.id, title: "Discount 100% done" }));
    await run((s) => createTask(s, { projectId: O.project.id, title: "snake_case name" }));
    await run((s) => createTask(s, { projectId: O.project.id, title: "snakeXcase decoy" }));
    const pct = await run((s) => searchAll(s, "100%"));
    expect(pct.tasks.map((t) => t.title)).toEqual(["Discount 100% done"]);
    const under = await run((s) => searchAll(s, "snake_case"));
    expect(under.tasks.map((t) => t.title)).toEqual(["snake_case name"]);
    const lone = await run((s) => searchAll(s, "%%"));
    expect(lone.tasks).toEqual([]);
  });

  it("finds Thai text, substrings of Thai words, and mixed Thai/English titles", async () => {
    await run((s) => createTask(s, { projectId: O.project.id, title: "จัดทำรายงานประจำเดือน", description: "ส่งให้ฝ่ายบัญชีภายในวันที่ 5" }));
    await run((s) => createTask(s, { projectId: O.project.id, title: "Review สัญญา vendor 🌏" }));
    expect((await run((s) => searchAll(s, "รายงาน"))).tasks.map((t) => t.title)).toEqual(["จัดทำรายงานประจำเดือน"]);
    expect((await run((s) => searchAll(s, "ฝ่ายบัญชี"))).tasks).toHaveLength(1); // description match
    expect((await run((s) => searchAll(s, "สัญญา vendor"))).tasks).toHaveLength(1);
    expect((await run((s) => searchAll(s, "🌏"))).tasks.length).toBeGreaterThanOrEqual(0); // must not throw on 4-byte characters
  });

  it("stores and returns Thai, emoji and combining characters unchanged, counting characters rather than bytes", async () => {
    const title = "ก".repeat(300); // 300 characters, 900 bytes: the limit is characters
    const t = await run((s) => createTask(s, { projectId: O.project.id, title }));
    expect(t.title).toBe(title);
    await expect(run((s) => createTask(s, { projectId: O.project.id, title: "ก".repeat(301) }))).rejects.toThrow();
    const emoji = await run((s) => createTask(s, { projectId: O.project.id, title: "👨‍👩‍👧‍👦 family + é" }));
    expect(emoji.title).toBe("👨‍👩‍👧‍👦 family + é");
  });
});
