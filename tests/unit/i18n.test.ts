import { describe, expect, it } from "vitest";
import { allMessages, t } from "@/i18n";
import { en } from "@/i18n/messages/en";
import { th } from "@/i18n/messages/th";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("localization", () => {
  it("Thai and English define exactly the same keys", () => {
    expect(Object.keys(th).sort()).toEqual(Object.keys(en).sort());
  });
  it("no empty strings", () => {
    for (const [loc, dict] of Object.entries(allMessages)) for (const [k, v] of Object.entries(dict)) expect(v.trim(), `${loc}:${k}`).not.toBe("");
  });
  it("placeholders match between languages", () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(placeholders(th[k]), k).toEqual(placeholders(en[k]));
  });
  it("interpolates and leaves unknown placeholders visible", () => {
    expect(t("en", "notify.assigned", { actor: "Ann", task: "Ship" })).toBe('Ann assigned you to "Ship"');
    expect(t("th", "notify.assigned", { actor: "แอน", task: "ส่งงาน" })).toContain("แอน");
    expect(t("en", "notify.assigned", { actor: "Ann" })).toContain("{task}");
  });
  it("Thai strings actually contain Thai script where expected", () => {
    for (const k of ["status.todo", "status.done", "ui.signin", "error.forbidden"] as const) expect(th[k]).toMatch(/[\u0E00-\u0E7F]/);
  });
  it("status and priority labels exist for every stored value", () => {
    for (const s of ["todo", "progress", "review", "done", "cancelled", "blocked"]) { expect(en[`status.${s}` as keyof typeof en]).toBeTruthy(); expect(th[`status.${s}` as keyof typeof th]).toBeTruthy(); }
    for (const p of ["low", "medium", "high", "urgent"]) { expect(en[`priority.${p}` as keyof typeof en]).toBeTruthy(); expect(th[`priority.${p}` as keyof typeof th]).toBeTruthy(); }
  });
});
