import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login, mails, preferEnglish, state, waitMail } from "./helpers";

/**
 * The administrators name the product (Settings -> General): the new name is on the sign-in page, in the page title, in the label of the menu (for
 * screen readers: the heading in the left bar is the organization's own name) and in the e-mails the organization sends. Runs after 11-registration-and-structure, which retires the second organization, so this installation holds exactly
 * one and its name is the name of the whole system.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const acme = () => state().acme.orgId;
const ORIGIN = "http://localhost:3100";
const NAME = "Bluebird Tasks";
const put = (page: Page, data: unknown) => page.request.put(`/api/orgs/${acme()}/settings`, { data, headers: { origin: ORIGIN } });
const card = (page: Page) => page.getByRole("region", { name: "Name of this system" });

test("an administrator names the system; the menu, the sign-in page, the page title and the e-mails follow, and it can be set back", async ({ page, browser }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  await page.getByRole("tab", { name: "General" }).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByLabel("Name")).toHaveValue("Task Tracker");
  await expect(card(page).getByRole("button", { name: "Use the default name" })).toHaveCount(0); // nothing to go back from
  await expectAccessible(page, "settings: general, with the name of the system");

  try {
    // a name that is not allowed is refused in words, and nothing changes
    await card(page).getByLabel("Name").fill("<b>Evil</b>");
    await card(page).getByRole("button", { name: "Save name" }).click();
    await expect(card(page).getByRole("alert")).toContainText(/1 to 40 characters/);
    await expect(page.getByRole("navigation", { name: "Task Tracker" })).toBeVisible();

    await card(page).getByLabel("Name").fill(`  ${NAME} `);
    await card(page).getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Name changed.")).toBeVisible();
    await expect(page.getByRole("navigation", { name: NAME })).toBeVisible(); // the menu's label (read by screen readers), at once
    await expect(card(page).getByLabel("Name")).toHaveValue(NAME);
    await expect(card(page).getByRole("button", { name: "Use the default name" })).toBeVisible();

    // somebody who is not signed in sees it on the sign-in page and in the tab title
    const anon = await browser.newContext();
    await anon.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
    const login1 = await anon.newPage();
    await login1.goto("/login");
    await expect(login1.getByRole("link", { name: NAME })).toBeVisible();
    await expect(login1).toHaveTitle(new RegExp(NAME));
    await expect(login1.getByText("Task Tracker")).toHaveCount(0);
    await anon.close();

    // and an e-mail the organization sends: subject, header, footer, and the sender's display name
    const before = mails().length;
    const address = `named-${Date.now()}@e2e.test`;
    const roles = (await (await page.request.get(`/api/orgs/${acme()}/roles`)).json()) as { roles: { id: string; key: string }[] };
    const viewer = roles.roles.find((r) => r.key === "viewer")!;
    const res = await page.request.post(`/api/orgs/${acme()}/invitations`, { data: { email: address, roleId: viewer.id, locale: "en" }, headers: { origin: ORIGIN } });
    expect(res.status()).toBe(201);
    const mail = await waitMail(address, /invited/i, before);
    expect(mail.subject).toMatch(new RegExp(`on ${NAME}$`));
    expect(mail.html).toContain(`>${NAME}<`);
    expect(mail.html).toContain(`from ${NAME}.`);
    expect(mail.html).not.toContain("Task Tracker");
    expect(mail.from).toBe(NAME);

    // back to the default
    await card(page).getByRole("button", { name: "Use the default name" }).click();
    await expect(page.getByRole("navigation", { name: "Task Tracker" })).toBeVisible();
    await expect(card(page).getByLabel("Name")).toHaveValue("Task Tracker");
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Task Tracker" })).toBeVisible();
  } finally {
    expect((await put(page, { appName: null })).status()).toBe(200); // the rest of the suite sees the default
  }
});

test("only an administrator may change it, and the server says so", async ({ page }) => {
  await login(page, "sam@e2e.test");
  expect((await put(page, { appName: "Not allowed" })).status()).toBe(403);
  expect((await page.request.get(`/api/orgs/${acme()}/settings`)).status()).toBe(403);
  await page.goto(`/o/${acme()}/settings`);
  await expect(page.getByRole("tab", { name: "General" })).toHaveCount(0);
});
