/**
 * The organization's own name: the heading of the left menu, the entry in "Your organizations", and the {org} in an invitation e-mail (its subject
 * included). The administrators change it (Settings -> General); the organization code (slug) stays what it was. It is separate from the name the
 * product goes by (src/domain/app-name.ts).
 *
 * It is free text, so the rules are about what cannot be displayed or sent safely, not about taste: a line break (or any control or invisible
 * formatting character: direction overrides, zero-width marks) must not reach an e-mail subject, and an empty name would leave a blank heading.
 * Everything else, in any script, is allowed; every page and e-mail escapes it like any other text.
 */
export const ORG_NAME_MAX = 80;

// control, format (zero-width, direction overrides), surrogate, private-use and unassigned code points
const INVISIBLE = /\p{C}/u;

export type OrgNameResult = { ok: true; value: string } | { ok: false };

/** Reads what a person typed: one space between words, trimmed, 1 to ORG_NAME_MAX characters, nothing invisible. */
export function parseOrgName(input: unknown): OrgNameResult {
  if (typeof input !== "string") return { ok: false };
  const value = input.normalize("NFC").replace(/\s+/g, " ").trim(); // a line break cannot survive this
  if (value === "" || [...value].length > ORG_NAME_MAX) return { ok: false };
  if (INVISIBLE.test(value)) return { ok: false };
  return { ok: true, value };
}
