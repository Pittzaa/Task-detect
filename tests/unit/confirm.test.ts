import { describe, expect, it } from "vitest";
import { confirmMatches, normalizeConfirm } from "@/lib/confirm";

describe("typed confirmation", () => {
  it("accepts the exact name, ignoring surrounding space and runs of spaces", () => {
    expect(confirmMatches("Marketing", "Marketing")).toBe(true);
    expect(confirmMatches("  Marketing \n", "Marketing")).toBe(true);
    expect(confirmMatches("Web   team", "Web team")).toBe(true);
    expect(confirmMatches("Web\tteam", "Web team")).toBe(true);
  });
  it("is case sensitive and refuses anything else", () => {
    expect(confirmMatches("marketing", "Marketing")).toBe(false);
    expect(confirmMatches("Marketing 2", "Marketing")).toBe(false);
    expect(confirmMatches("Market", "Marketing")).toBe(false);
    expect(confirmMatches("", "Marketing")).toBe(false);
    expect(confirmMatches("   ", "Marketing")).toBe(false);
  });
  it("never matches when the expected name is empty, even against an empty answer", () => {
    expect(confirmMatches("", "")).toBe(false);
    expect(confirmMatches("  ", " ")).toBe(false);
  });
  it("treats the same text in different Unicode forms as the same (a name pasted from elsewhere)", () => {
    const composed = "café";
    const decomposed = "café";
    expect(composed).not.toBe(decomposed);
    expect(confirmMatches(decomposed, composed)).toBe(true);
    expect(normalizeConfirm("ก่า")).toBe(normalizeConfirm("ก่า"));
  });
  it("does not fold look-alike characters (a Cyrillic а is not a Latin a)", () => {
    expect(confirmMatches("Mаrketing", "Marketing")).toBe(false);
  });
  it("does not treat zero-width characters as nothing: a name with one is not the name without it", () => {
    expect(confirmMatches("Market​ing", "Marketing")).toBe(false);
  });
});
