import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login, mails, preferEnglish, state, waitMail } from "./helpers";

/**
 * How every organization starts, and what fits Vercel Hobby (automatic e-mail OFF, no per-minute scheduler): the bell fills by itself
 * because the background work also runs when people use the app, no notification e-mail leaves until an administrator sends the waiting
 * ones, only an administrator is offered the switch and the button, and switching automatic e-mail on makes e-mails go out by themselves.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const acme = () => state().acme.orgId;
const ORIGIN = "http://localhost:3100";
const TITLE = "Manual mail task";
const post = (page: Page, path: string, data: unknown) => page.request.post(path, { data, headers: { origin: ORIGIN } });
const waiting = async (page: Page) => ((await (await page.request.get(`/api/orgs/${acme()}/notification-emails`)).json()) as { waiting: number });

test("the bell shows an assignment by itself, and no e-mail about it is sent", async ({ page, browser }) => {
  await login(page, "admin@e2e.test");
  const members = (await (await page.request.get(`/api/orgs/${acme()}/members`)).json()) as { members: { userId: string; email: string }[] };
  const sam = members.members.find((m) => m.email === "sam@e2e.test")!;
  const projects = (await (await page.request.get(`/api/orgs/${acme()}/projects`)).json()) as { projects: { id: string }[] };
  const before = mails().length;
  const created = await post(page, `/api/orgs/${acme()}/tasks`, { projectId: projects.projects[0]!.id, title: TITLE, primaryAssigneeId: sam.userId });
  expect(created.status()).toBe(201);

  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const samPage = await ctx.newPage();
  await login(samPage, "sam@e2e.test");
  await samPage.goto(`/o/${acme()}/my-tasks`);
  await samPage.getByRole("button", { name: /^Notifications/ }).click();
  // nothing called /api/cron/tick: the work was run by the requests above and the page's own polling
  await expect(samPage.getByRole("region", { name: "Notifications" }).getByRole("link", { name: new RegExp(`assigned you to "${TITLE}"`) })).toBeVisible({ timeout: 45_000 });
  await ctx.close();

  expect(mails().slice(before).filter((m) => m.to === "sam@e2e.test" && m.text.includes(TITLE))).toHaveLength(0);
});

test("an administrator sees what is waiting and sends it; the person gets the e-mail and nothing waits afterwards", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  const section = page.getByRole("region", { name: "Sending e-mails" });
  await expect(section).toBeVisible();
  await expect(section.getByRole("switch", { name: "Send notification e-mails automatically" })).not.toBeChecked();
  await expect(section.getByText(/each e-mail waits here until you press/i)).toBeVisible();
  await expect(section.getByText(/\d+ e-mail\(s\) waiting to be sent/)).toBeVisible();
  expect((await waiting(page)).waiting).toBeGreaterThanOrEqual(1);
  await expectAccessible(page, "settings: notifications with the e-mail sending card");

  const before = mails().length;
  await section.getByRole("button", { name: "Send waiting e-mails now" }).click();
  await expect(page.getByText(/e-mail\(s\) are being sent/)).toBeVisible();
  const mail = await waitMail("sam@e2e.test", new RegExp(TITLE), before);
  expect(mail.subject).toContain(TITLE);
  await expect.poll(async () => (await waiting(page)).waiting, { timeout: 20_000 }).toBe(0);
  await expect(section.getByRole("button", { name: "Send waiting e-mails now" })).toBeDisabled({ timeout: 70_000 });
});

test("a member sees the explanation but no button, the digests are switched off, and the API refuses them", async ({ page }) => {
  await login(page, "sam@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  await expect(page.getByText(/E-mail is sent when an administrator sends the waiting e-mails/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Sending e-mails" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send waiting e-mails now" })).toHaveCount(0);
  await expect(page.getByLabel("Email digest")).toBeDisabled();
  expect((await page.request.get(`/api/orgs/${acme()}/notification-emails`)).status()).toBe(403);
  expect((await post(page, `/api/orgs/${acme()}/notification-emails`, {})).status()).toBe(403);
  expect((await page.request.put(`/api/orgs/${acme()}/settings`, { data: { autoEmail: true }, headers: { origin: ORIGIN } })).status()).toBe(403);
  await expectAccessible(page, "settings: notifications as a member");
});

test("switching automatic e-mail on makes the next e-mail go out by itself; the settings page follows the switch", async ({ page, browser }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  const section = page.getByRole("region", { name: "Sending e-mails" });
  const sw = section.getByRole("switch", { name: "Send notification e-mails automatically" });
  const members = (await (await page.request.get(`/api/orgs/${acme()}/members`)).json()) as { members: { userId: string; email: string }[] };
  const sam = members.members.find((m) => m.email === "sam@e2e.test")!;
  const projects = (await (await page.request.get(`/api/orgs/${acme()}/projects`)).json()) as { projects: { id: string }[] };
  await sw.check();
  try {
    await expect(section.getByText(/each e-mail is sent as soon as the background work runs/i)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "Sending e-mails" }).getByRole("switch", { name: "Send notification e-mails automatically" })).toBeChecked();
    await expect(page.getByLabel("Email digest")).toBeEnabled();
    await expectAccessible(page, "settings: notifications with automatic e-mail on");

    const before = mails().length;
    const created = await post(page, `/api/orgs/${acme()}/tasks`, { projectId: projects.projects[0]!.id, title: "Automatic mail task", primaryAssigneeId: sam.userId });
    expect(created.status()).toBe(201);
    const mail = await waitMail("sam@e2e.test", /Automatic mail task/, before); // nobody pressed anything and nothing called the cron
    expect(mail.subject).toContain("Automatic mail task");

    // a member sees no explanation about waiting e-mails any more
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
    const samPage = await ctx.newPage();
    await login(samPage, "sam@e2e.test");
    await samPage.goto(`/o/${acme()}/settings`);
    await expect(samPage.getByLabel("Email digest")).toBeEnabled();
    await expect(samPage.getByText(/E-mail is sent when an administrator sends the waiting e-mails/)).toHaveCount(0);
    await ctx.close();
  } finally {
    await page.goto(`/o/${acme()}/settings`);
    const back = page.getByRole("region", { name: "Sending e-mails" }).getByRole("switch", { name: "Send notification e-mails automatically" });
    await back.uncheck(); // the rest of the suite runs the way a new organization starts
    await expect(back).not.toBeChecked();
    await page.reload();
    await expect(page.getByRole("region", { name: "Sending e-mails" }).getByRole("switch", { name: "Send notification e-mails automatically" })).not.toBeChecked();
  }
});
