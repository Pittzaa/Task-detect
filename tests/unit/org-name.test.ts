import { describe, expect, it } from "vitest";
import { ORG_NAME_MAX, parseOrgName } from "@/domain/org-name";

const ok = (v: unknown) => { const r = parseOrgName(v); return r.ok ? r.value : "REFUSED"; };

describe("parseOrgName", () => {
  it("accepts ordinary names in any script, with the punctuation companies use", () => {
    for (const name of ["Acme Co.", "สยามดีไซน์ จำกัด (ตัวอย่าง)", "Müller & Söhne GmbH", "Работа №1", "仕事管理 株式会社", "Smith, Jones & Partners", "R&D <HQ>", 'The "Best" Team', "Team 7/Alpha", "O'Brien's", "Café 🚀"]) expect(ok(name), name).toBe(name);
  });

  it("trims, collapses white space into one space, and normalizes composed forms", () => {
    expect(ok("  Acme   Co  ")).toBe("Acme Co");
    expect(ok("Acme\nCo")).toBe("Acme Co"); // a line break cannot get through to an e-mail subject
    expect(ok("Acme\r\n\tCo")).toBe("Acme Co");
    expect(ok("Cafe\u0301")).toBe("Caf\u00e9"); // e + combining accent becomes the single é
    expect(ok("e\u0301".repeat(ORG_NAME_MAX))).toBe("\u00e9".repeat(ORG_NAME_MAX)); // the length is judged after that, so 80 of them fit
  });

  it("refuses an empty name: an organization is never without one", () => {
    for (const bad of ["", "   ", "\n", "\t \n"]) expect(ok(bad), JSON.stringify(bad)).toBe("REFUSED");
  });

  it("refuses control, zero-width and direction-control characters", () => {
    for (const bad of ["a\u0000b", "a\u0007b", "a\u001fb", "a\u007fb", "a​b", "a‍b", "a‎b", "a‮b", "a⁦b", "a\ud800b", "a͸b"]) expect(ok(bad), JSON.stringify(bad)).toBe("REFUSED");
  });

  it("refuses non-strings and names that are too long, counting characters rather than bytes", () => {
    for (const bad of [7, true, null, undefined, {}, [], ["a"]]) expect(ok(bad)).toBe("REFUSED");
    expect(ok("a".repeat(ORG_NAME_MAX))).toBe("a".repeat(ORG_NAME_MAX));
    expect(ok("a".repeat(ORG_NAME_MAX + 1))).toBe("REFUSED");
    expect(ok("ก".repeat(ORG_NAME_MAX))).toBe("ก".repeat(ORG_NAME_MAX));
    expect(ok("ก".repeat(ORG_NAME_MAX + 1))).toBe("REFUSED");
    expect(ok("😀".repeat(ORG_NAME_MAX))).toBe("😀".repeat(ORG_NAME_MAX)); // one emoji is one character, though two UTF-16 units
    expect(ok("😀".repeat(ORG_NAME_MAX + 1))).toBe("REFUSED");
  });
});
