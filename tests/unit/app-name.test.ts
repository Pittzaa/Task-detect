import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME_MAX, DEFAULT_APP_NAME, appNameOrDefault, parseAppName } from "@/domain/app-name";
import { formatFrom } from "@/integrations/email";

const ok = (v: unknown) => { const r = parseAppName(v); return r.ok ? r.value : "REFUSED"; };

describe("parseAppName", () => {
  it("accepts names in any script, with the punctuation a product name needs", () => {
    for (const name of ["Acme Tasks", "งานของเรา", "Siam Design Co.", "Team & Co", "Tasks (HQ)", "O'Brien Works", "A+B: Plan!", "ระบบติดตามงาน บริษัท สยาม", "Работа", "仕事管理", "tasks_2027-1"]) expect(ok(name), name).toBe(name);
  });

  it("trims, collapses runs of white space into one space, and normalizes composed forms", () => {
    expect(ok("  Acme   Tasks  ")).toBe("Acme Tasks");
    expect(ok("Acme\nTasks")).toBe("Acme Tasks"); // a line break cannot get through to an e-mail header: it is a space by now
    expect(ok("Acme\r\n\tTasks")).toBe("Acme Tasks");
    expect(ok("Café")).toBe("Café"); // e + combining accent becomes é
  });

  it("reads empty and null as 'use the default'", () => {
    expect(ok("")).toBeNull();
    expect(ok("   ")).toBeNull();
    expect(ok(null)).toBeNull();
    expect(ok(undefined)).toBeNull();
  });

  it("refuses what could be misread in a header, in HTML or as an address", () => {
    for (const bad of ['Acme "Tasks"', "Acme <b>Tasks</b>", "<script>alert(1)</script>", "boss@bank.example", "A;B", "A\\B", "A/B", "A|B", "Acme\u0000Tasks", "A​B", "A‮B", "😀 Tasks", "Tasks 🚀", "#hash", "-Leading dash", ".Leading dot", "' or 1=1 --"]) expect(ok(bad), JSON.stringify(bad)).toBe("REFUSED");
  });

  it("refuses non-strings and names that are too long, counting characters rather than bytes", () => {
    for (const bad of [7, true, {}, [], ["a"]]) expect(ok(bad)).toBe("REFUSED");
    expect(ok("a".repeat(APP_NAME_MAX))).toBe("a".repeat(APP_NAME_MAX));
    expect(ok("a".repeat(APP_NAME_MAX + 1))).toBe("REFUSED");
    expect(ok("ก".repeat(APP_NAME_MAX))).toBe("ก".repeat(APP_NAME_MAX)); // 40 Thai letters are 120 bytes in UTF-8 and still fit
    expect(ok("ก".repeat(APP_NAME_MAX + 1))).toBe("REFUSED");
  });
});

describe("appNameOrDefault", () => {
  it("is the stored name, or the default for null, empty and anything that no longer passes the rules", () => {
    expect(appNameOrDefault("Acme Tasks")).toBe("Acme Tasks");
    expect(appNameOrDefault(null)).toBe(DEFAULT_APP_NAME);
    expect(appNameOrDefault(undefined)).toBe(DEFAULT_APP_NAME);
    expect(appNameOrDefault("")).toBe(DEFAULT_APP_NAME);
    expect(appNameOrDefault("<b>x</b>")).toBe(DEFAULT_APP_NAME); // a row edited by hand cannot put markup into a page or an e-mail
  });
});

describe("formatFrom: the sender of an e-mail", () => {
  it("puts the product's name in front of the configured address, always quoted", () => {
    expect(formatFrom("no-reply@mail.example", "Acme Tasks")).toBe('"Acme Tasks" <no-reply@mail.example>');
    expect(formatFrom("Task Tracker <no-reply@mail.example>", "Acme Tasks")).toBe('"Acme Tasks" <no-reply@mail.example>');
    expect(formatFrom('"Task Tracker" <no-reply@mail.example>', "ระบบงาน")).toBe('"ระบบงาน" <no-reply@mail.example>');
    expect(formatFrom("a@b.example", "Acme, Inc.")).toBe('"Acme, Inc." <a@b.example>'); // a comma in a name is safe only inside quotes
  });

  it("keeps the configured display name (or none) when there is no valid name to use", () => {
    expect(formatFrom("Task Tracker <no-reply@mail.example>")).toBe('"Task Tracker" <no-reply@mail.example>');
    expect(formatFrom("no-reply@mail.example")).toBe("no-reply@mail.example");
    expect(formatFrom("Task Tracker <no-reply@mail.example>", "")).toBe('"Task Tracker" <no-reply@mail.example>');
  });

  it("cannot be steered to another address or another header by a hostile name", () => {
    for (const evil of ['x" <evil@x.example>; "y', "x\r\nBcc: evil@x.example", "evil@x.example", "<evil@x.example>"]) {
      const from = formatFrom("no-reply@mail.example", evil);
      expect(from, JSON.stringify(evil)).toBe("no-reply@mail.example");
      expect(from).not.toMatch(/[\r\n]/);
    }
    // and the address part is only ever the configured one
    expect(formatFrom("Task Tracker <no-reply@mail.example>", 'Acme" <evil@x.example>')).toBe('"Task Tracker" <no-reply@mail.example>');
  });
});

describe("the product's name is never written into the code", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
  const src = files("src").map((p) => [p, readFileSync(p, "utf8")] as const);

  it("'Task Tracker' appears only as the default name (the domain file and the message dictionaries)", () => {
    const allowed = new Set(["src/domain/app-name.ts", "src/i18n/messages/en.ts", "src/i18n/messages/th.ts"]);
    const stray = src.filter(([p, s]) => !allowed.has(p) && /Task Tracker/.test(s)).map(([p]) => p);
    expect(stray).toEqual([]);
  });

  it("server code never asks the dictionary for the name: it carries the organization's own name (src/server/brand.ts)", () => {
    const stray = src.filter(([p, s]) => /^src\/(jobs|server|data|integrations|app\/api)\//.test(p) && /["']app\.name["']/.test(s)).map(([p]) => p);
    expect(stray).toEqual([]);
  });
});
