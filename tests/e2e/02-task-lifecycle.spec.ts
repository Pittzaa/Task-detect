import { expect, test, type Page } from "@playwright/test";
import { login, state, preferEnglish, alerts } from "./helpers";

/**
 * Real browser, real server, real database. Runs after 01-onboarding (the administrator and the viewer Sam exist).
 * Everything the user sees is asserted through accessible roles and labels, never CSS classes.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const acme = () => state().acme.orgId;
// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const drawer = (page: Page) => page.getByRole("dialog");

async function openTask(page: Page, title: string) {
  await page.goto(`/o/${acme()}/tasks`);
  await page.getByRole("button", { name: title, exact: true }).first().click();
  await expect(drawer(page).getByRole("heading", { name: title, level: 2 })).toBeVisible();
}

async function createTask(page: Page, title: string, extra: { due?: string } = {}) {
  await page.goto(`/o/${acme()}/tasks`);
  await page.getByRole("button", { name: /New task/ }).click();
  const modal = page.getByRole("dialog", { name: "New task" });
  await modal.getByLabel("Title").fill(title);
  if (extra.due) await modal.getByLabel("Due").fill(extra.due);
  await modal.getByRole("button", { name: "Create" }).click();
  await expect(drawer(page).getByRole("heading", { name: title, level: 2 })).toBeVisible();
}

test("the administrator builds the structure: department, team, project", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await page.goto(`/o/${acme()}/structure`);
  await expect(page.getByRole("heading", { name: "Structure", level: 1 })).toBeVisible();
  const section = (name: string) => page.getByRole("region", { name });
  await section("Departments").getByLabel("New department").fill("Engineering");
  await section("Departments").getByRole("button", { name: "Create" }).click();
  await expect(section("Departments").getByText("Engineering")).toBeVisible();
  await section("Teams").getByLabel("New team").fill("Web team");
  await section("Teams").getByRole("button", { name: "Create" }).click();
  await expect(section("Teams").getByText("Web team")).toBeVisible();
  await section("Projects").getByLabel("New project").fill("Website");
  await section("Projects").getByRole("button", { name: "Create" }).click();
  await expect(section("Projects").getByText("Website")).toBeVisible();
});

test("create a task, edit it, and walk the status workflow with only legal moves offered", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await createTask(page, "Design homepage", { due: "2030-06-30" });
  const d = drawer(page);
  // From "To do" the only forward moves are in-progress / blocked / cancelled; "Done" is not offered.
  const moves = d.getByRole("group", { name: "Status" });
  await expect(moves.getByRole("button", { name: "→ In progress" })).toBeVisible();
  await expect(moves.getByRole("button", { name: "→ Done" })).toHaveCount(0);

  await d.getByLabel("Title").fill("Design the homepage");
  await d.getByLabel("Priority").selectOption({ label: "High" });
  await d.getByRole("form", { name: "Edit" }).getByRole("button", { name: "Save" }).click();
  await expect(d.getByRole("heading", { name: "Design the homepage", level: 2 })).toBeVisible();

  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ In progress" }).click();
  await expect(d.getByText("(To do → In progress)")).toBeVisible();
  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ Done" }).click();
  await expect(d.getByText("(In progress → Done)")).toBeVisible();
  // leaving a finished task requires the reopen permission, which the administrator has
  await expect(d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ To do" })).toBeVisible();
});

test("a parent cannot be completed while a subtask is open", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await createTask(page, "Launch campaign");
  const d = drawer(page);
  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ In progress" }).click();
  await expect(d.getByText("(To do → In progress)")).toBeVisible();
  await d.getByPlaceholder("New subtask").fill("Write copy");
  await d.getByRole("button", { name: "+", exact: true }).click();
  await expect(d.getByRole("button", { name: "Write copy" })).toBeVisible();

  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ Done" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "All subtasks must be done or cancelled first" })).toBeVisible();
  await expect(d.getByText("(In progress → Done)")).toHaveCount(0);

  // finishing the subtask first unlocks the parent
  await d.getByRole("button", { name: "Write copy" }).click();
  await expect(d.getByRole("heading", { name: "Write copy", level: 2 })).toBeVisible();
  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ In progress" }).click();
  await expect(d.getByText("(To do → In progress)")).toBeVisible();
  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ Done" }).click();
  await expect(d.getByText("(In progress → Done)")).toBeVisible();
});

test("a task cannot start until its prerequisite is done, and circular dependencies are refused", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await createTask(page, "Write content");
  await createTask(page, "Publish site");
  const d = drawer(page);
  await d.getByLabel("Add prerequisite").fill("Write content");
  await d.getByRole("button", { name: "Add", exact: true }).click();
  await expect(d.getByRole("button", { name: "Write content" })).toBeVisible();

  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ In progress" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Prerequisite tasks must be done first" })).toBeVisible();
  await expect(d.getByText("(To do → In progress)")).toHaveCount(0);

  // the reverse edge would be a cycle
  await d.getByRole("button", { name: "Write content" }).click();
  await expect(d.getByRole("heading", { name: "Write content", level: 2 })).toBeVisible();
  await d.getByLabel("Add prerequisite").fill("Publish site");
  await d.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "circular dependency" })).toBeVisible();

  // finish the prerequisite; now the dependent can start
  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ In progress" }).click();
  await expect(d.getByText("(To do → In progress)")).toBeVisible();
  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ Done" }).click();
  await expect(d.getByText("(In progress → Done)")).toBeVisible();
  await d.getByRole("button", { name: "Publish site" }).click();
  await expect(d.getByRole("heading", { name: "Publish site", level: 2 })).toBeVisible();
  await d.getByRole("group", { name: "Status" }).getByRole("button", { name: "→ In progress" }).click();
  await expect(d.getByText("(To do → In progress)")).toBeVisible();
});

test("comments are plain text: markup is shown literally and never executed", async ({ page }) => {
  await login(page, "admin@e2e.test");
  let dialogs = 0;
  page.on("dialog", (dlg) => { dialogs++; void dlg.dismiss(); });
  await openTask(page, "Design the homepage");
  const d = drawer(page);
  const body = `<img src=x onerror="alert(1)"> <script>alert(2)</script> **not bold**`;
  await d.getByRole("textbox", { name: "Comments" }).fill(body);
  await d.getByRole("button", { name: "Post" }).click();
  await expect(d.getByText(body)).toBeVisible();
  expect(await d.locator("img[src='x']").count()).toBe(0);
  expect(await d.locator("strong", { hasText: "not bold" }).count()).toBe(0);
  expect(dialogs).toBe(0);
});

test("mentioning a member adds the mention text to the comment", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await openTask(page, "Design the homepage");
  const d = drawer(page);
  await d.getByLabel("Mention").selectOption({ label: "Sam Member" });
  await expect(d.getByRole("textbox", { name: "Comments" })).toHaveValue(/@Sam Member /);
  await d.getByRole("textbox", { name: "Comments" }).fill("@Sam Member please review");
  await d.getByRole("button", { name: "Post" }).click();
  await expect(d.getByText("@Sam Member please review")).toBeVisible();
});

test("attachments: allowed files upload and download as attachments, HTML is refused", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await openTask(page, "Design the homepage");
  const d = drawer(page);
  await d.getByLabel("Upload file").setInputFiles({ name: "mock.png", mimeType: "image/png", buffer: PNG });
  const link = d.getByRole("link", { name: "mock.png" });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href"))!;
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toMatch(/^attachment/);
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(Buffer.compare(await res.body(), PNG)).toBe(0);

  await d.getByLabel("Upload file").setInputFiles({ name: "evil.html", mimeType: "text/html", buffer: Buffer.from("<html><script>alert(1)</script></html>") });
  await expect(alerts(page)).toBeVisible();
  await expect(d.getByRole("link", { name: "evil.html" })).toHaveCount(0);
});

test("attachments: a file over the server limit is refused up front when no Blob store is configured, without sending it", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await openTask(page, "Design the homepage");
  const d = drawer(page);
  await expect(d.getByText(/Max 4 MB/)).toBeVisible(); // large uploads are only offered where a Blob store exists
  let uploads = 0;
  page.on("request", (r) => { if (r.method() === "POST" && /\/attachments(\/direct)?$/.test(new URL(r.url()).pathname)) uploads++; });
  await d.getByLabel("Upload file").setInputFiles({ name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(5_000_000, 0x20)]) });
  await expect(page.getByText("This file is too large (the limit is 4 MB).")).toBeVisible();
  await expect(d.getByRole("link", { name: "big.pdf" })).toHaveCount(0);
  expect(uploads).toBe(0);
});

test("delete a task and bring it back with undo", async ({ page }) => {
  await login(page, "admin@e2e.test");
  await createTask(page, "Temporary task");
  const d = drawer(page);
  page.once("dialog", (dlg) => void dlg.accept());
  await d.getByRole("button", { name: "Delete task" }).click();
  await expect(page.getByRole("button", { name: "Temporary task", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Temporary task", exact: true })).toBeVisible();
});

test("a viewer sees the work but has no editing controls, and the server agrees", async ({ page }) => {
  await login(page, "sam@e2e.test");
  await page.goto(`/o/${acme()}/tasks`);
  await expect(page.getByRole("button", { name: "Design the homepage", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /New task/ })).toBeDisabled();
  await page.getByRole("button", { name: "Design the homepage", exact: true }).click();
  const d = drawer(page);
  await expect(d.getByText("You do not have permission to edit this.")).toBeVisible();
  await expect(d.getByLabel("Title")).toBeDisabled();
  await expect(d.getByRole("button", { name: "Delete task" })).toHaveCount(0);
  await expect(d.getByLabel("Upload file")).toHaveCount(0);
  await expect(d.getByRole("group", { name: "Status" })).toHaveCount(0);
  // the viewer cannot navigate to administration, and calling the API directly is refused
  await expect(page.getByRole("link", { name: "Members" })).toHaveCount(0);
  const res = await page.request.post(`/api/orgs/${acme()}/tasks`, { data: { projectId: "00000000-0000-4000-8000-000000000000", title: "nope" }, headers: { origin: "http://localhost:3100" } });
  expect([403, 404]).toContain(res.status());
});
