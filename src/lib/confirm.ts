/**
 * Deleting something that matters asks the person to type its name. The same comparison is used by the screen (to enable the
 * button) and by the server (to refuse a request that did not carry the name), so they can never disagree: same Unicode
 * form, surrounding space ignored, runs of spaces counted as one, upper and lower case still different.
 */
export const normalizeConfirm = (s: string): string => s.normalize("NFC").trim().replace(/\s+/g, " ");

export const confirmMatches = (typed: string, expected: string): boolean => {
  const want = normalizeConfirm(expected);
  return want.length > 0 && normalizeConfirm(typed) === want;
};
