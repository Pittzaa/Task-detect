import { expect, test } from "@playwright/test";
import { PASSWORD, attemptLogin, linkIn, login, mails, register, state, useEnglish, waitMail } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => { await useEnglish(page); });

test("an unauthenticated visitor is sent to sign in and sees no data", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.goto(`/o/${state().acme.orgId}/tasks`);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("registration requires email verification before sign-in", async ({ page }) => {
  const before = mails().length;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Early Bird");
  await page.getByLabel("Email").fill("early@e2e.test");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/Check your email/i)).toBeVisible();
  await attemptLogin(page, "early@e2e.test");
  await expect(page.getByText(/verify your email/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  const mail = await waitMail("early@e2e.test", /verify-email/, before);
  await page.goto(linkIn(mail));
  await login(page, "early@e2e.test");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(/not a member of any organization/i)).toBeVisible();
});

test("the first administrator signs up with the invited address and accepts the invitation", async ({ page }) => {
  await register(page, "Ada Admin", "admin@e2e.test");
  await login(page, "admin@e2e.test", `/invite?token=${new URL(state().acme.inviteUrl).searchParams.get("token")}`);
  await expect(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText("Invitation accepted.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/o/${state().acme.orgId}/my-tasks`));
  await expect(page.getByRole("link", { name: "Members" })).toBeVisible();
});

test("a stranger cannot use someone else's invitation", async ({ page }) => {
  await register(page, "Stranger", "stranger@e2e.test");
  await login(page, "stranger@e2e.test", `/invite?token=${new URL(state().globex.inviteUrl).searchParams.get("token")}`);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText(/invalid, expired, or for a different email/i)).toBeVisible();
});

test("self-registration: request access with the organization code, stay locked out until approved", async ({ page }) => {
  await register(page, "Sam Member", "sam@e2e.test");
  await login(page, "sam@e2e.test");
  await page.goto("/join");
  await page.getByLabel("Organization code").fill("acme");
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page.getByText(/Request sent/)).toBeVisible();
  // an unknown code looks exactly the same
  await page.getByLabel("Organization code").fill("does-not-exist");
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page.getByText(/Request sent/)).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  const res = await page.request.get(`/api/orgs/${state().acme.orgId}/tasks`);
  expect(res.status()).toBe(404);
});

test("the administrator approves the pending member with a role", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${state().acme.orgId}/members`);
  await expect(page.getByRole("heading", { name: /Waiting for approval/ })).toBeVisible();
  const row = page.locator("div.row", { hasText: "Sam Member" }).first();
  await row.getByLabel("Role").selectOption({ label: "viewer" });
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { name: /Waiting for approval/ })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "Sam Member" })).toBeVisible();
  // now Sam can get in
  await page.context().clearCookies();
  await useEnglish(page);
  await login(page, "sam@e2e.test");
  await expect(page).toHaveURL(new RegExp(`/o/${state().acme.orgId}/my-tasks`));
});
