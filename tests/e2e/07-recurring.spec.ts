import { expect, test } from "@playwright/test";
import { alerts, login, state, preferEnglish } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const acme = () => state().acme.orgId;
const ORIGIN = "http://localhost:3100";

test("an administrator creates a weekly recurring task and its upcoming occurrences appear in the task list", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/my-tasks`);
  await page.getByRole("link", { name: "Recurring tasks" }).click();
  await expect(page.getByRole("heading", { name: "Recurring tasks", level: 1 })).toBeVisible();
  await expect(page.getByText("Tasks that are in the past, started or finished are never changed.")).toBeVisible();

  await page.getByRole("button", { name: /New recurring task/ }).click();
  const form = page.getByRole("dialog", { name: "New recurring task" });
  await form.getByLabel("Title").fill("Weekly status report");
  await form.getByLabel("Repeat").selectOption("weekly");
  for (const d of ["Mon", "Wed", "Fri"]) await form.getByLabel(d, { exact: true }).check();
  await form.getByLabel("Starts").fill(new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date()));
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Recurring task created \(\d+ task\(s\) scheduled\)/)).toBeVisible();
  const row = page.getByRole("row", { name: /Weekly status report/ });
  await expect(row).toContainText("Every 1 week(s)");
  await expect(row).toContainText("Active");

  await page.goto(`/o/${acme()}/tasks?q=${encodeURIComponent("Weekly status report")}`);
  const occurrences = page.getByRole("button", { name: "Weekly status report", exact: true });
  await expect(occurrences.first()).toBeVisible();
  expect(await occurrences.count()).toBeGreaterThanOrEqual(4); // Mon/Wed/Fri for ~30 days
  await occurrences.first().click();
  await expect(page.getByRole("dialog").getByText("Part of a recurring series")).toBeVisible();
});

test("pausing and resuming; editing a schedule updates only open future occurrences", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/recurring`);
  const row = () => page.getByRole("row", { name: /Weekly status report/ });
  await row().getByRole("button", { name: "Pause" }).click();
  await expect(row()).toContainText("Paused");
  await row().getByRole("button", { name: "Resume" }).click();
  await expect(row()).toContainText("Active");

  await row().getByRole("button", { name: /Edit: Weekly status report/ }).click();
  const form = page.getByRole("dialog", { name: /Edit: Weekly status report/ });
  await form.getByLabel("Title").fill("Weekly status report v2");
  await form.getByLabel("Also update open tasks in the future").check();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row", { name: /Weekly status report v2/ })).toBeVisible();

  await page.goto(`/o/${acme()}/tasks?q=${encodeURIComponent("Weekly status report")}`);
  await expect(page.getByRole("button", { name: "Weekly status report v2", exact: true }).first()).toBeVisible();
});

test("a person without the permission neither sees the page link nor can create a series", async ({ page }) => {
  await login(page, "sam@e2e.test");
  await page.goto(`/o/${acme()}/my-tasks`);
  await expect(page.getByRole("link", { name: "Recurring tasks" })).toHaveCount(0);
  const projects = (await (await page.request.get(`/api/orgs/${acme()}/projects`)).json()) as { projects: { id: string; name: string }[] };
  const res = await page.request.post(`/api/orgs/${acme()}/series`, {
    data: { projectId: projects.projects[0]!.id, title: "nope", rule: { freq: "daily", interval: 1 }, startDate: "2030-01-01" },
    headers: { origin: ORIGIN },
  });
  expect(res.status()).toBe(403);
});

test("deleting a series removes its open future occurrences after confirmation", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/recurring`);
  page.once("dialog", (d) => void d.dismiss());
  await page.getByRole("row", { name: /Weekly status report v2/ }).getByRole("button", { name: /Delete: Weekly status report v2/ }).click();
  await expect(page.getByRole("row", { name: /Weekly status report v2/ })).toBeVisible(); // cancelled: still there
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("row", { name: /Weekly status report v2/ }).getByRole("button", { name: /Delete: Weekly status report v2/ }).click();
  await expect(page.getByRole("row", { name: /Weekly status report v2/ })).toHaveCount(0);
  await expect(alerts(page)).toHaveCount(0);

  await page.goto(`/o/${acme()}/tasks?q=${encodeURIComponent("Weekly status report")}`);
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});
