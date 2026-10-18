import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { taskLink } from "@/lib/links";

describe("taskLink", () => {
  it("points at the tasks page with ?task=, which is the only page that can show a task", () => {
    expect(taskLink("https://tasks.example.com", "o1", "t1")).toBe("https://tasks.example.com/o/o1/tasks?task=t1");
    expect(taskLink("https://tasks.example.com/", "o1", "t1")).toBe("https://tasks.example.com/o/o1/tasks?task=t1");
    expect(existsSync("src/app/o/[orgId]/tasks/page.tsx")).toBe(true);
    expect(existsSync("src/app/o/[orgId]/tasks/[taskId]")).toBe(false); // if a task page is ever added, this link can become shorter
  });
  it("escapes what it is given", () => {
    expect(taskLink("https://a.example", "o/1", "t?x=1&y")).toBe("https://a.example/o/o%2F1/tasks?task=t%3Fx%3D1%26y");
  });
});
