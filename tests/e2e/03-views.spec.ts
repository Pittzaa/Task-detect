import { expect, test, type Page } from "@playwright/test";
import { login, mails, state, useEnglish } from "./helpers";

/** Runs after 01 and 02 (same database, same users). Test data is created through the API, then checked through the UI. */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await useEnglish(page); });

const acme = () => state().acme.orgId;
const ORIGIN = "http://localhost:3100";
const CRON = "e2e-cron-secret-123456";

const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function post<T = Record<string, unknown>>(page: Page, path: string, data: unknown): Promise<T> {
  const r = await page.request.post(path, { data, headers: { origin: ORIGIN } });
  expect(r.ok(), `${path}: ${await r.text()}`).toBe(true);
  return (await r.json()) as T;
}

let today = "";
let adminId = "";
let projectId = "";
const ids: Record<string, string> = {};

test("seed: tasks with dates, an assignee and a dependency", async ({ page }) => {
  await login(page, "admin@e2e.test");
  const me = (await (await page.request.get("/api/me")).json()) as { id: string; timezone: string };
  adminId = me.id;
  today = new Intl.DateTimeFormat("en-CA", { timeZone: me.timezone }).format(new Date());
  const projects = (await (await page.request.get(`/api/orgs/${acme()}/projects`)).json()) as { projects: { id: string; name: string }[] };
  projectId = projects.projects.find((p) => p.name === "Website")!.id;
  const make = async (key: string, title: string, extra: Record<string, unknown>) => {
    const r = await post<{ id: string }>(page, `/api/orgs/${acme()}/tasks`, { projectId, title, ...extra });
    ids[key] = r.id;
  };
  await make("overdue", "Overdue chore", { dueDate: addDays(today, -3), primaryAssigneeId: adminId });
  await make("today", "Due today chore", { dueDate: today, primaryAssigneeId: adminId });
  await make("sprint", "Sprint planning", { startDate: addDays(today, -1), dueDate: addDays(today, 2) });
  await make("backlog", "Backlog item", { primaryAssigneeId: adminId });
  await make("later", "Later chore", { dueDate: addDays(today, 30), primaryAssigneeId: adminId });
  await post(page, `/api/orgs/${acme()}/tasks/${ids.sprint}/dependencies`, { prerequisiteId: ids.overdue });
});

test("My tasks groups my open work by urgency and shows nothing assigned to others", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/my-tasks`);
  await expect(page.getByRole("heading", { name: "My tasks", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: /Overdue/ }).getByRole("button", { name: "Overdue chore" })).toBeVisible();
  await expect(page.getByRole("region", { name: /Today/ }).getByRole("button", { name: "Due today chore" })).toBeVisible();
  await expect(page.getByRole("region", { name: /No date/ }).getByRole("button", { name: "Backlog item" })).toBeVisible();
  await expect(page.getByRole("region", { name: /Later/ }).getByRole("button", { name: "Later chore" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sprint planning" })).toHaveCount(0); // unassigned
  // finishing from here removes it from the open list
  await page.getByLabel("Status: Due today chore").selectOption({ label: "→ In progress" });
  await expect(page.getByLabel("Status: Due today chore")).toHaveValue("progress");
});

test("List view filters are kept in the URL and survive a reload", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/tasks`);
  await page.getByRole("group", { name: "Status" }).getByRole("button", { name: "In progress" }).click();
  await expect(page).toHaveURL(/status=progress/);
  await expect(page.getByRole("button", { name: "Due today chore", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Backlog item", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Due today chore", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Backlog item", exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Status" }).getByRole("button", { name: "In progress" })).toHaveAttribute("aria-pressed", "true");
});

test("Board shows one column per status, and a card moves when its status changes", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/tasks?view=board`);
  const col = (name: string) => page.getByRole("listitem", { name });
  for (const s of ["To do", "In progress", "In review", "Done", "Cancelled", "Blocked"]) await expect(col(s)).toBeVisible();
  await expect(col("To do").getByRole("button", { name: "Backlog item" })).toBeVisible();
  await page.getByLabel("Status: Backlog item").selectOption({ label: "→ In progress" });
  await expect(col("In progress").getByRole("button", { name: "Backlog item" })).toBeVisible();
  await expect(col("To do").getByRole("button", { name: "Backlog item" })).toHaveCount(0);
  // "Done" is not a legal move from "To do": it is not even offered
  await expect(page.getByLabel("Status: Overdue chore").locator("option", { hasText: "→ Done" })).toHaveCount(0);
});

test("Board: dropping a card onto a column changes its status through the server", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/tasks?view=board`);
  const card = page.getByRole("article").filter({ hasText: "Later chore" });
  await card.dragTo(page.getByRole("listitem", { name: "In progress" }));
  await expect(page.getByRole("listitem", { name: "In progress" }).getByRole("button", { name: "Later chore" })).toBeVisible();
});

test("Calendar places a multi-day task on each of its days and navigates by month", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/tasks?view=calendar`);
  const grid = page.getByRole("grid", { name: "Calendar" });
  await expect(grid.getByRole("button", { name: "Sprint planning" }).first()).toBeVisible();
  expect(await grid.getByRole("button", { name: "Sprint planning" }).count()).toBeGreaterThanOrEqual(3);
  const heading = page.getByRole("heading", { level: 2 }).filter({ hasText: /\d{4}/ }).first();
  const before = await heading.textContent();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(heading).not.toHaveText(before!);
  await page.getByRole("button", { name: "Today" }).click();
  await expect(heading).toHaveText(before!);
  await grid.getByRole("button", { name: "Overdue chore" }).first().click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Overdue chore", level: 2 })).toBeVisible();
});

test("Timeline draws a bar per dated task and a dependency arrow between visible tasks", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/tasks?view=timeline`);
  const table = page.getByRole("table", { name: "Timeline" });
  await expect(table.getByRole("button", { name: /^Sprint planning:/ })).toBeVisible();
  await expect(table.getByRole("button", { name: /^Overdue chore:/ })).toBeVisible();
  await expect(table.getByRole("button", { name: /^Backlog item:/ })).toHaveCount(0); // no dates: omitted, and the note says so
  await expect(page.getByText(/Tasks without dates are not shown/)).toBeVisible();
  await expect(table.locator("svg path[marker-end]")).toHaveCount(1);
  await page.getByRole("button", { name: "Months" }).click();
  await expect(page.getByRole("button", { name: "Months" })).toHaveAttribute("aria-pressed", "true");
});

test("Dashboard counts match the data and can be narrowed to a project", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/dashboard`);
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  const kpi = (label: string) => page.locator(".card", { has: page.getByText(label, { exact: true }) }).locator(".kpi").first();
  expect(Number(await kpi("Overdue").textContent())).toBeGreaterThanOrEqual(1);
  expect(Number(await kpi("Open").textContent())).toBeGreaterThanOrEqual(5);
  await expect(page.getByRole("progressbar", { name: "Website" })).toBeVisible();
  await page.getByRole("combobox", { name: "Project" }).selectOption({ label: "Website" });
  await expect(page.getByRole("img", { name: /^In progress: \d+$/ })).toBeVisible();
});

test("Search finds tasks and a saved view re-applies its filters", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/my-tasks`);
  await page.getByRole("searchbox", { name: "Search" }).first().fill("Sprint");
  await page.getByRole("searchbox", { name: "Search" }).first().press("Enter");
  await expect(page.getByRole("link", { name: "Sprint planning" })).toBeVisible();
  await page.getByRole("link", { name: "Sprint planning" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Sprint planning", level: 2 })).toBeVisible();

  await page.goto(`/o/${acme()}/tasks?status=progress`);
  await page.getByRole("button", { name: "Save view" }).click();
  await page.getByRole("dialog", { name: "Save view" }).getByLabel("Name").fill("Active work");
  await page.getByRole("dialog", { name: "Save view" }).getByRole("button", { name: "Save" }).click();
  await page.goto(`/o/${acme()}/tasks`);
  await expect(page.getByRole("button", { name: "Backlog item", exact: true })).toBeVisible(); // unfiltered
  await page.getByRole("combobox", { name: "Saved views" }).selectOption({ label: "Active work · Only me" });
  await expect(page).toHaveURL(/status=progress/);
});

test("the cron endpoint refuses callers without the secret, then delivers the mention to the viewer", async ({ page, request }) => {
  const denied = await request.get("/api/cron/tick");
  expect(denied.status()).toBe(401);
  const wrong = await request.get("/api/cron/tick", { headers: { authorization: "Bearer not-the-secret-not-the-secret" } });
  expect(wrong.status()).toBe(401);

  const before = mails().length;
  const ok = await request.get("/api/cron/tick", { headers: { authorization: `Bearer ${CRON}` } });
  expect(ok.status()).toBe(200);
  expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);

  await login(page, "sam@e2e.test");
  await page.goto(`/o/${acme()}/my-tasks`);
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const bell = page.getByRole("region", { name: "Notifications" });
  await expect(bell.getByRole("link", { name: /Ada Admin mentioned you on "Design the homepage"/ })).toBeVisible();
  // an email was queued and delivered through the sink for the same event
  expect(mails().slice(before).some((m) => m.to === "sam@e2e.test")).toBe(true);
  await bell.getByRole("link", { name: /mentioned you/ }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Design the homepage", level: 2 })).toBeVisible();
});
