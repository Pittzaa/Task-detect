import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = "correct-horse-battery-9";
const EMAILS = ".data/e2e/emails.jsonl";
export const state = () => JSON.parse(readFileSync(".data/e2e/state.json", "utf8")) as { acme: { orgId: string; inviteUrl: string }; globex: { orgId: string; inviteUrl: string } };

interface Mail { to: string; subject: string; text: string; at: string }
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

export async function useEnglish(page: Page) {
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
