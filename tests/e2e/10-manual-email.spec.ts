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

test("an administrator sees what is waiting and sends it; the person gets the e-mail (HTML) and the one-a-day deadline e-mail, and nothing waits afterwards", async ({ page }) => {
  await login(page, "admin@e2e.test");
  // something of Sam's that is overdue by any calendar: the deadline e-mail must list it
  const members = (await (await page.request.get(`/api/orgs/${acme()}/members`)).json()) as { members: { userId: string; email: string }[] };
  const sam = members.members.find((m) => m.email === "sam@e2e.test")!;
  const projects = (await (await page.request.get(`/api/orgs/${acme()}/projects`)).json()) as { projects: { id: string }[] };
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  expect((await post(page, `/api/orgs/${acme()}/tasks`, { projectId: projects.projects[0]!.id, title: "Overdue for the deadline mail", primaryAssigneeId: sam.userId, dueDate: twoDaysAgo })).status()).toBe(201);

  await page.goto(`/o/${acme()}/settings`);
  const section = page.getByRole("region", { name: "Sending e-mails" });
  await expect(section).toBeVisible();
  await expect(section.getByRole("switch", { name: "Send notification e-mails automatically" })).not.toBeChecked();
  await expect(section.getByText(/each e-mail waits here until you press/i)).toBeVisible();
  await expect(section.getByText(/\d+ e-mail\(s\) waiting to be sent/)).toBeVisible();
  await expect.poll(async () => (await waiting(page)).waiting, { timeout: 45_000 }).toBeGreaterThanOrEqual(1);
  await expectAccessible(page, "settings: notifications with the e-mail sending card");

  const before = mails().length;
  await section.getByRole("button", { name: "Send waiting e-mails now" }).click();
  await expect(page.getByText(/e-mail\(s\) are being sent/)).toBeVisible();
  const mail = await waitMail("sam@e2e.test", new RegExp(TITLE), before);
  expect(mail.subject).toContain(TITLE);
  expect(mail.html.startsWith("<!doctype html>")).toBe(true); // every e-mail is HTML
  expect(mail.html).toContain("<a href=");
  expect(mail.text).toContain(TITLE); // with a plain-text twin

  const deadline = await waitMail("sam@e2e.test", /Your unfinished tasks|งานที่ยังไม่เสร็จของคุณ/, before);
  expect(deadline.html.startsWith("<!doctype html>")).toBe(true);
  expect(deadline.html).toContain("Overdue for the deadline mail");
  expect(deadline.subject).toMatch(/Unfinished tasks|งานที่ยังไม่เสร็จ/);
  expect(mails().slice(before).filter((m) => m.to === "sam@e2e.test" && /Your unfinished tasks|งานที่ยังไม่เสร็จของคุณ/.test(m.text))).toHaveLength(1); // one, not one per task

  await expect.poll(async () => (await waiting(page)).waiting, { timeout: 20_000 }).toBe(0);
  // pressing again the same day sends no second deadline e-mail
  const again = mails().length;
  await section.getByRole("button", { name: "Send waiting e-mails now" }).click();
  await expect(page.getByText(/e-mail\(s\) are being sent/).first()).toBeVisible();
  await page.waitForTimeout(4000);
  expect(mails().slice(again).filter((m) => m.to === "sam@e2e.test" && /Your unfinished tasks|งานที่ยังไม่เสร็จของคุณ/.test(m.text))).toHaveLength(0);
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
    await expect(section.getByText(/e-mails are sent without anyone pressing a button/i)).toBeVisible();
    await expect(section.getByRole("radio", { name: /Right away/ })).toBeChecked(); // "instant" is what automatic e-mail always meant
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

test("the daily mode: an administrator chooses 'once a day at 23:00 Thai time', it is remembered, members are told, and the button sends what is held", async ({ page, browser }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  const section = () => page.getByRole("region", { name: "Sending e-mails" });
  const sw = () => section().getByRole("switch", { name: "Send notification e-mails automatically" });
  // the choice of when appears only with the switch on
  await expect(section().getByRole("radio")).toHaveCount(0);
  await sw().check();
  try {
    await expect(section().getByRole("radio")).toHaveCount(2);
    await section().getByRole("radio", { name: /Once a day at 23:00 Thai time/ }).check();
    await expect(section().getByText(/held and go out in the run at 23:00 Thai time/)).toBeVisible();
    await page.reload();
    await expect(section().getByRole("radio", { name: /Once a day at 23:00 Thai time/ })).toBeChecked();
    await expect(section().getByRole("radio", { name: /Right away/ })).not.toBeChecked();
    await expectAccessible(page, "settings: notifications, daily e-mail mode");
    expect((await page.request.put(`/api/orgs/${acme()}/settings`, { data: { emailSchedule: "weekly" }, headers: { origin: ORIGIN } })).status()).toBe(422);

    // a member is told, and has no control
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
    const samPage = await ctx.newPage();
    await login(samPage, "sam@e2e.test");
    await samPage.goto(`/o/${acme()}/settings`);
    await expect(samPage.getByText(/E-mail is sent once a day, at 23:00 Thai time/)).toBeVisible();
    await expect(samPage.getByRole("radio")).toHaveCount(0);
    expect((await samPage.request.put(`/api/orgs/${acme()}/settings`, { data: { emailSchedule: "instant" }, headers: { origin: ORIGIN } })).status()).toBe(403);
    await ctx.close();

    // an e-mail made now: held until 23:00 Thai time unless it is already past 23:00 (and before 04:00), when it goes at once
    const members = (await (await page.request.get(`/api/orgs/${acme()}/members`)).json()) as { members: { userId: string; email: string }[] };
    const sam = members.members.find((m) => m.email === "sam@e2e.test")!;
    const projects = (await (await page.request.get(`/api/orgs/${acme()}/projects`)).json()) as { projects: { id: string }[] };
    const thaiHour = (new Date().getUTCHours() + 7) % 24;
    const inWindow = thaiHour >= 23 || thaiHour < 4;
    const before = mails().length;
    expect((await post(page, `/api/orgs/${acme()}/tasks`, { projectId: projects.projects[0]!.id, title: "Daily mode task", primaryAssigneeId: sam.userId })).status()).toBe(201);
    if (!inWindow) {
      // wait for THIS notification (the app makes it, and holds its e-mail, a moment after the task is saved). The waiting count alone is not
      // enough: other e-mails may be waiting already, and pressing the button before this one exists would send those and miss it.
      const other = await browser.newContext();
      await other.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
      const samPage = await other.newPage();
      await login(samPage, "sam@e2e.test");
      await expect.poll(async () => JSON.stringify(await (await samPage.request.get(`/api/orgs/${acme()}/notifications`)).json()).includes("Daily mode task"), { timeout: 45_000 }).toBe(true);
      await other.close();
      expect((await waiting(page)).waiting).toBeGreaterThanOrEqual(1); // held, and counted as waiting
      expect(mails().slice(before).filter((m) => m.to === "sam@e2e.test" && m.text.includes("Daily mode task"))).toHaveLength(0);
      await page.goto(`/o/${acme()}/settings`);
      await section().getByRole("button", { name: "Send waiting e-mails now" }).click();
    }
    const mail = await waitMail("sam@e2e.test", /Daily mode task/, before);
    expect(mail.html.startsWith("<!doctype html>")).toBe(true);
  } finally {
    await page.goto(`/o/${acme()}/settings`);
    await section().getByRole("radio", { name: /Right away/ }).check().catch(() => undefined);
    await sw().uncheck(); // the rest of the suite runs the way a new organization starts
    await expect(sw()).not.toBeChecked();
  }
});
