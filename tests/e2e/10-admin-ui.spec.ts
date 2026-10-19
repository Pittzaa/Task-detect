import { expect, test, type Page } from "@playwright/test";
import { alerts, cancelDeletion, confirmDeletion, linkIn, login, mails, preferEnglish, register, state, waitMail } from "./helpers";

/**
 * The administration screens, driven the way an administrator would use them: invitations, custom roles with scoped
 * assignments (and what the invited person can then actually see), member lifecycle with confirmations, notification
 * preferences, custom fields with validation, labels, Discord destinations (no secret ever shown) and the audit log.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const acme = () => state().acme.orgId;
const ORIGIN = "http://localhost:3100";
const row = (page: Page, name: RegExp | string) => page.getByRole("row", { name });
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${"UiSecretToken".repeat(4)}`;

test("invite a person by e-mail; they register with that address and accept", async ({ page, browser }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/members`);
  await page.getByRole("tab", { name: "Invitations" }).click();
  const before = mails().length;
  await page.getByLabel("Email to invite").fill("ivy@e2e.test");
  await page.getByLabel("Role", { exact: true }).selectOption({ label: "viewer" });
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Invitation sent")).toBeVisible();
  await expect(row(page, /ivy@e2e\.test/)).toBeVisible();
  const mail = await waitMail("ivy@e2e.test", /invite/, before);

  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const ivy = await ctx.newPage();
  await register(ivy, "Ivy Invitee", "ivy@e2e.test");
  await login(ivy, "ivy@e2e.test", new URL(linkIn(mail)).pathname + new URL(linkIn(mail)).search);
  await ivy.getByRole("button", { name: "Accept invitation" }).click();
  await expect(ivy.getByText("Invitation accepted.")).toBeVisible();
  await ctx.close();

  await page.reload(); // the list refreshes on focus and every 30 s; a reload is the deterministic way in a test
  await expect(row(page, /Ivy Invitee/)).toContainText("viewer");
  await page.getByRole("tab", { name: "Invitations" }).click();
  await expect(row(page, /ivy@e2e\.test/)).toContainText("Invitation accepted.");
});

test("a custom role scoped to one team: the person sees nothing until the team participates in the project", async ({ page, browser }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/members`);
  await page.getByRole("tab", { name: "Roles" }).click();
  await page.getByLabel("Key (a-z, 0-9, _)").fill("reporter");
  await page.getByLabel("Name", { exact: true }).fill("Reporter");
  for (const p of ["org.read", "department.read", "team.read", "project.read", "task.read", "task.comment"]) await page.getByRole("checkbox", { name: p, exact: true }).check();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Reporter" })).toBeVisible();

  await page.getByRole("tab", { name: "Members" }).click();
  const ivyRow = row(page, /Ivy Invitee/);
  await ivyRow.getByRole("button", { name: "Assign role" }).click();
  await ivyRow.getByLabel("Role", { exact: true }).selectOption({ label: "Reporter" });
  await ivyRow.getByLabel("Scope").first().selectOption({ label: "Team" });
  await ivyRow.getByLabel("Scope").nth(1).selectOption({ label: "Web team" });
  await ivyRow.getByRole("button", { name: "Save" }).click();
  await expect(row(page, /Ivy Invitee/)).toContainText("reporter (team)");

  // drop the organization-wide viewer role: only the team-scoped role is left
  const members = (await (await page.request.get(`/api/orgs/${acme()}/members`)).json()) as { members: { email: string; roles: { id: string; roleKey: string; scopeType: string }[] }[] };
  const viewer = members.members.find((m) => m.email === "ivy@e2e.test")!.roles.find((r) => r.roleKey === "viewer")!;
  expect((await page.request.delete(`/api/orgs/${acme()}/assignments/${viewer.id}`, { headers: { origin: ORIGIN } })).status()).toBe(200);

  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const ivy = await ctx.newPage();
  await login(ivy, "ivy@e2e.test");
  const tasks = () => ivy.request.get(`/api/orgs/${acme()}/tasks`).then((r) => r.json() as Promise<{ items: unknown[] }>);
  expect((await tasks()).items).toHaveLength(0); // the team does not participate in any project yet

  await page.goto(`/o/${acme()}/structure`);
  const website = page.getByRole("listitem").filter({ hasText: "Website" });
  await website.getByRole("button", { name: "Participating teams" }).click();
  await page.getByRole("dialog").getByLabel("Web team").check();
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toBeHidden(); // saved: the request has completed

  expect((await tasks()).items.length).toBeGreaterThan(0);
  await ivy.goto(`/o/${acme()}/tasks`);
  await ivy.getByRole("button", { name: "Design the homepage", exact: true }).click();
  const d = ivy.getByRole("dialog");
  await expect(d.getByText("You do not have permission to edit this.")).toBeVisible(); // reporter may comment, not edit
  await expect(d.getByRole("textbox", { name: "Comments" })).toBeVisible();
  await expect(d.getByLabel("Title")).toBeDisabled();
  await expect(ivy.getByRole("button", { name: /New task/ })).toBeDisabled();

  // and a task in a project the team does not participate in stays invisible
  const created = await page.request.post(`/api/orgs/${acme()}/projects`, { data: { name: "Private project" }, headers: { origin: ORIGIN } });
  const priv = ((await created.json()) as { id: string }).id;
  const secret = await page.request.post(`/api/orgs/${acme()}/tasks`, { data: { projectId: priv, title: "Hidden from Ivy" }, headers: { origin: ORIGIN } });
  const secretId = ((await secret.json()) as { id: string }).id;
  expect((await ivy.request.get(`/api/orgs/${acme()}/tasks/${secretId}`)).status()).toBe(404);
  expect(JSON.stringify(await (await ivy.request.get(`/api/orgs/${acme()}/search?q=Hidden`)).json())).not.toContain("Hidden from Ivy");
  await ctx.close();
});

test("member lifecycle: suspend, reactivate, and a revoke that asks first", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/members`);
  const ivyRow = () => row(page, /Ivy Invitee/);
  await ivyRow().getByRole("button", { name: "Suspend" }).click();
  await expect(ivyRow()).toContainText("Suspended");
  await ivyRow().getByRole("button", { name: "Reactivate" }).click();
  await expect(ivyRow()).toContainText("Approved");

  await ivyRow().getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm deletion" })).toContainText("invited again");
  await cancelDeletion(page);
  await expect(ivyRow()).toContainText("Approved"); // cancelled: nothing happened
  await ivyRow().getByRole("button", { name: "Revoke" }).click();
  await confirmDeletion(page, "ivy@e2e.test"); // the person's address has to be typed
  await expect(ivyRow()).toContainText("Revoked");
  await expect(ivyRow().getByRole("button", { name: "Reactivate" })).toHaveCount(0);
});

test("the last administrator cannot be suspended or revoked through the interface either", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/members`);
  const me = row(page, /Ada Admin/);
  await me.getByRole("button", { name: "Suspend" }).click();
  await expect(alerts(page).filter({ hasText: /cannot suspend or revoke your own|at least one administrator/i })).toBeVisible();
  await expect(me).toContainText("Approved");
});

test("notification preferences persist across reloads", async ({ page }) => {
  await login(page, "sam@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  const box = page.getByRole("checkbox", { name: "task.commented email" });
  const was = await box.isChecked();
  await box.click(); // controlled by the server round trip, so the state flips when the save returns
  await expect.poll(async () => ((await (await page.request.get(`/api/orgs/${acme()}/notification-settings`)).json()) as { settings: { event: string; channel: string; enabled: boolean }[] }).settings.find((s) => s.event === "task.commented" && s.channel === "email")!.enabled).toBe(!was);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "task.commented email" })).toBeChecked({ checked: !was });
  // digests only run with automatic e-mail; in the default manual mode the choice is shown but cannot be changed (10-manual-email.spec.ts)
  await expect(page.getByLabel("Email digest")).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "task.commented email" })).toBeChecked({ checked: !was });
  await page.getByRole("checkbox", { name: "task.commented email" }).click(); // restore the shared account's setting
  await expect(page.getByRole("checkbox", { name: "task.commented email" })).toBeChecked({ checked: was });
});

test("custom fields: create a bounded number field, then the task form enforces the bounds", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  await page.getByRole("tab", { name: "Custom fields" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Story points");
  await page.getByLabel("Type").selectOption("number");
  await page.getByLabel("Minimum").fill("0");
  await page.getByLabel("Maximum").fill("100");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(row(page, /Story points/)).toContainText("Number");

  await page.goto(`/o/${acme()}/tasks`);
  await page.getByRole("button", { name: "Design the homepage", exact: true }).click();
  const section = page.getByRole("dialog").getByRole("region", { name: "Custom fields" });
  await expect(section.getByLabel("Story points")).toBeVisible();
  await section.getByLabel("Story points").fill("150");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(alerts(page).first()).toBeVisible(); // out of range is refused
  await section.getByLabel("Story points").fill("42");
  await section.getByRole("button", { name: "Save" }).click();
  await page.reload(); // the open task is part of the URL, so the drawer comes back by itself
  await expect(page.getByRole("dialog").getByRole("region", { name: "Custom fields" }).getByLabel("Story points")).toHaveValue("42");
});

test("labels: create one, attach it in the task drawer, and filter the list by it", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  await page.getByRole("tab", { name: "Labels" }).click();
  await page.getByLabel("Name", { exact: true }).fill("urgent-customer");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("urgent-customer")).toBeVisible();

  await page.goto(`/o/${acme()}/tasks`);
  await page.getByRole("button", { name: "Design the homepage", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: /urgent-customer/ }).click(); // state follows the saved result
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: /urgent-customer/ })).toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await page.getByRole("search", { name: "Filters" }).getByLabel("Labels").selectOption({ label: "urgent-customer" });
  await expect(page.getByRole("button", { name: "Design the homepage", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Backlog item", exact: true })).toHaveCount(0);
});

test("Discord destinations: the webhook secret is never shown again, can be disabled, replaced and deleted (after confirmation)", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/settings`);
  await page.getByRole("tab", { name: "Integrations" }).click();
  const section = page.getByRole("region", { name: "Discord" });
  await section.getByLabel("Name", { exact: true }).fill("Dev channel");
  await section.getByLabel("Send events for").selectOption({ label: "Website" });
  await section.getByLabel("Webhook URL").fill(WEBHOOK);
  await section.getByRole("button", { name: "Create" }).click();
  await expect(section.getByText("Dev channel")).toBeVisible();
  await expect(section.getByLabel("Webhook URL")).toHaveValue(""); // the form was cleared after saving
  // only a short hint is displayed; the secret token is nowhere in the page or the API answer
  expect(await page.content()).not.toContain("UiSecretToken");
  const api = JSON.stringify(await (await page.request.get(`/api/orgs/${acme()}/integrations/discord`)).json());
  expect(api).not.toContain("UiSecretToken");
  expect(api).not.toContain("discord.com/api/webhooks/123456789012345678");

  const dev = section.locator("div.row.between", { hasText: "Dev channel" });
  await dev.getByRole("button", { name: "Disable" }).click();
  await expect(dev.getByRole("button", { name: "Enable" })).toBeVisible();
  await dev.getByRole("button", { name: "Replace webhook" }).click();
  await dev.getByLabel("Webhook URL").fill(`https://discord.com/api/webhooks/123456789012345678/${"Replaced".repeat(6)}`);
  await dev.getByRole("button", { name: "Save" }).click();
  await expect(dev.getByLabel("Webhook URL")).toHaveCount(0); // the replace form closed: saved
  await expect(dev.getByRole("button", { name: "Disable" })).toBeVisible(); // replacing the webhook re-enables the destination
  expect(await page.content()).not.toContain("Replaced");

  // a URL that is not a Discord webhook is refused (SSRF protection)
  await section.getByLabel("Name", { exact: true }).fill("Evil");
  await section.getByLabel("Send events for").selectOption({ label: "Website" });
  await section.getByLabel("Webhook URL").fill("http://169.254.169.254/latest/meta-data/");
  await section.getByRole("button", { name: "Create" }).click();
  await expect(alerts(page).first()).toBeVisible();
  await expect(section.getByText("Evil")).toHaveCount(0);

  await dev.getByRole("button", { name: "Delete" }).click();
  await cancelDeletion(page, "escape");
  await expect(section.getByText("Dev channel")).toBeVisible();
  await dev.getByRole("button", { name: "Delete" }).click();
  await confirmDeletion(page, "Dev channel");
  await expect(section.getByText("Dev channel")).toHaveCount(0);
});

test("the audit log recorded all of this, can be filtered, and contains no secrets", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/audit`);
  await expect(page.getByRole("cell", { name: "role.create" }).first()).toBeVisible();
  await page.getByLabel("Action").fill("membership.");
  await expect(page.getByRole("cell", { name: /^membership\./ }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "role.create" })).toHaveCount(0);
  await page.getByLabel("Action").fill("integration.");
  await expect(page.getByRole("cell", { name: "integration.create" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "integration.delete" }).first()).toBeVisible();
  await page.getByLabel("Action").fill("");
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/UiSecretToken|Replaced|discord\.com\/api\/webhooks|password|token/i);
});
