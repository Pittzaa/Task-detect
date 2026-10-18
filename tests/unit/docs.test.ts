import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rbacMatrixMarkdown } from "@/authz/matrix";
import { PERMISSIONS } from "@/authz/permissions";
import { registry } from "@/jobs/registry";

const read = (p: string) => readFileSync(p, "utf8");

describe("documentation stays in step with the code", () => {
  it("docs/generated/rbac-matrix.md equals the matrix generated from the permission catalog (run `pnpm docs:generate`)", () => {
    expect(read("docs/generated/rbac-matrix.md")).toBe(rbacMatrixMarkdown());
  });

  it("docs/RBAC.md embeds the current matrix and names every permission", () => {
    const doc = read("docs/RBAC.md");
    expect(doc).toContain(rbacMatrixMarkdown().trim());
    for (const p of PERMISSIONS) expect(doc, p).toContain(`\`${p}\``);
  });

  it("docs/ENVIRONMENT.md documents every variable the environment schema accepts", () => {
    const keys = [...read("src/config/env.ts").matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!).filter((k) => k !== "NODE_ENV");
    expect(keys.length).toBeGreaterThan(10);
    const doc = read("docs/ENVIRONMENT.md");
    for (const k of keys) expect(doc, k).toContain(`\`${k}\``);
  });

  it(".env.example lists every variable the environment schema accepts", () => {
    const keys = [...read("src/config/env.ts").matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!).filter((k) => k !== "NODE_ENV");
    const example = read(".env.example");
    for (const k of keys) expect(example, k).toMatch(new RegExp(`^#?\\s*${k}=`, "m"));
  });

  it("docs/ARCHITECTURE.md mentions every registered job kind", () => {
    const doc = read("docs/ARCHITECTURE.md");
    for (const kind of Object.keys(registry)) expect(doc, kind).toContain(kind.replace(/^calendar\..*/, "calendar."));
  });

  it("every relative link in README.md, README_VPS.md and docs/*.md points at a file that exists", () => {
    const files = ["README.md", "README_VPS.md", ...readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => path.join("docs", f))];
    const broken: string[] = [];
    for (const file of files) {
      for (const m of read(file).matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = path.normalize(path.join(path.dirname(file), m[1]!));
        if (!existsSync(target)) broken.push(`${file} → ${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
