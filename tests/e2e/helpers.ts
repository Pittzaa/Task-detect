import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = "correct-horse-battery-9";
const EMAILS = ".data/e2e/emails.jsonl";
export const state = () => JSON.parse(readFileSync(".data/e2e/state.json", "utf8")) as { acme: { orgId: string; inviteUrl: string }; globex: { orgId: string; inviteUrl: string } };

interface Mail { to: string; subject: string; text: string; html: string; at: string }
export function mails(): Mail[] {
  try { return readFileSync(EMAILS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Mail); } catch { return []; }
}

/** Waits for the newest email to `to` matching `pattern` (test mail sink, no network). */
export async function waitMail(to: string, pattern: RegExp, since = 0): Promise<Mail> {
  for (let i = 0; i < 80; i++) {
    const m = mails().slice(since).reverse().find((x) => x.to === to && pattern.test(x.text));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no email to ${to} matching ${pattern}`);
}
export const linkIn = (m: Mail) => m.text.match(/https?:\/\/\S+/)![0].replace(/[).,]+$/, "");

export async function preferEnglish(page: Page) {
  await page.context().addCookies([{ name: "tt_locale", value: "en", url: "http://localhost:3100" }]);
}

export async function register(page: Page, name: string, email: string) {
  const before = mails().length;
  await page.goto("/register");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/Check your email/i)).toBeVisible();
  const mail = await waitMail(email, /verify-email/, before);
  await page.goto(linkIn(mail));
  await expect(page).toHaveURL(/\/login/);
}

/** Submits the sign-in form without asserting the outcome (for tests that expect it to be refused). */
export async function attemptLogin(page: Page, email: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function login(page: Page, email: string, next?: string) {
  await attemptLogin(page, email, next);
  // Wait until the session cookie is set and the app navigated away, so a following goto cannot abort the sign-in request.
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
}

/** Fails with the rule, impact and first offending elements for every WCAG 2.0/2.1 A/AA violation on the current page. */
export async function expectAccessible(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = result.violations.map((v) => `${v.id} [${v.impact}] ${v.help}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `accessibility violations on ${label}`).toEqual([]);
}

export function base32Decode(input: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString("utf8");
}

export async function totpFromUri(uri: string): Promise<string> {
  const { createOTP } = await import("@better-auth/utils/otp");
  return createOTP(base32Decode(new URL(uri).searchParams.get("secret")!)).totp();
}

/** App alerts only: Next.js adds its own empty role="alert" route announcer to every page. */
export const alerts = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

/**
 * Answers the "type the name to confirm" dialog that every deletion of something that matters opens: the button stays disabled
 * for a wrong or partial name, Enter does not get round that, and it is enabled by the exact name.
 */
export async function confirmDeletion(page: Page, phrase: string) {
  const dialog = page.getByRole("dialog", { name: /^Confirm (deletion|archiving)$/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(phrase, { exact: true })).toBeVisible(); // the name to type is shown, so it can be copied
  const button = dialog.getByRole("button", { name: /^(Delete permanently|Archive)$/ });
  const field = dialog.getByLabel("Type the name to confirm");
  await expect(button).toBeDisabled();
  await field.fill(phrase.slice(0, -1) || "x");
  await expect(button).toBeDisabled();
  await field.press("Enter"); // submitting the form with a wrong name must do nothing
  await expect(dialog).toBeVisible();
  await field.fill("");
  await field.pressSequentially(phrase); // real keystrokes: focus must stay in the field while the page re-renders on each one
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(phrase);
  await expect(button).toBeEnabled();
  await button.click();
  await expect(dialog).toBeHidden();
}

/** Opens the same dialog and leaves it without deleting: through Cancel, or Escape. */
export async function cancelDeletion(page: Page, how: "cancel" | "escape" = "cancel") {
  const dialog = page.getByRole("dialog", { name: /^Confirm (deletion|archiving)$/ });
  await expect(dialog).toBeVisible();
  if (how === "cancel") await dialog.getByRole("button", { name: "Cancel" }).click();
  else await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}
