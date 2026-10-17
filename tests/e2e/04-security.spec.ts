import { expect, test } from "@playwright/test";
import { PASSWORD, login, attemptLogin, register, state, totpFromUri, useEnglish, alerts } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await useEnglish(page); });

const ORIGIN = "http://localhost:3100";
const acme = () => state().acme.orgId;
const globex = () => state().globex.orgId;
let secretTaskId = "";
let secretProjectId = "";

test("a second tenant exists with its own private task", async ({ page }) => {
  await register(page, "Boss Globex", "boss@e2e.test");
  await login(page, "boss@e2e.test", `/invite?token=${new URL(state().globex.inviteUrl).searchParams.get("token")}`);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText("Invitation accepted.")).toBeVisible();
  const proj = await page.request.post(`/api/orgs/${globex()}/projects`, { data: { name: "Globex Ops" }, headers: { origin: ORIGIN } });
  expect(proj.ok()).toBe(true);
  secretProjectId = ((await proj.json()) as { id: string }).id;
  const task = await page.request.post(`/api/orgs/${globex()}/tasks`, { data: { projectId: secretProjectId, title: "Globex secret plan", description: "launch codes" }, headers: { origin: ORIGIN } });
  expect(task.ok()).toBe(true);
  secretTaskId = ((await task.json()) as { id: string }).id;
});

test("tenant isolation in the browser: another organization's data is unreachable by URL, API or search", async ({ page }) => {
  await login(page, "admin@e2e.test");

  // the page for someone else's organization renders no data
  await page.goto(`/o/${globex()}/tasks`);
  await expect(alerts(page)).toContainText("Not found");
  await expect(page.getByText("Globex secret plan")).toHaveCount(0);

  // direct API access, both through the foreign org id and by smuggling the foreign id into your own org
  const probes: [string, string][] = [
    ["GET", `/api/orgs/${globex()}/tasks`],
    ["GET", `/api/orgs/${globex()}/projects`],
    ["GET", `/api/orgs/${globex()}/members`],
    ["GET", `/api/orgs/${globex()}/audit-logs`],
    ["GET", `/api/orgs/${globex()}/tasks/${secretTaskId}`],
    ["GET", `/api/orgs/${acme()}/tasks/${secretTaskId}`],
    ["GET", `/api/orgs/${acme()}/tasks/${secretTaskId}/comments`],
    ["GET", `/api/orgs/${acme()}/tasks/${secretTaskId}/attachments`],
    ["GET", `/api/orgs/${acme()}/projects/${secretProjectId}`],
    ["GET", `/api/orgs/${acme()}/projects/${secretProjectId}/people`],
  ];
  for (const [method, url] of probes) {
    const res = await page.request.fetch(url, { method });
    expect.soft(res.status(), `${method} ${url}`).toBe(404);
    expect.soft(await res.text(), `${method} ${url}`).not.toContain("Globex secret plan");
  }

  // writing into your own organization with the other tenant's project is refused as well
  const create = await page.request.post(`/api/orgs/${acme()}/tasks`, { data: { projectId: secretProjectId, title: "smuggled" }, headers: { origin: ORIGIN } });
  expect(create.status()).toBe(404);
  const move = await page.request.post(`/api/orgs/${acme()}/tasks/${secretTaskId}/status`, { data: { status: "progress" }, headers: { origin: ORIGIN } });
  expect(move.status()).toBe(404);

  // the drawer for a foreign task id inside your own organization leaks nothing
  await page.goto(`/o/${acme()}/tasks?task=${secretTaskId}`);
  await expect(page.getByRole("dialog").locator('[role="alert"]')).toBeVisible();
  await expect(page.getByText("Globex secret plan")).toHaveCount(0);
  await expect(page.getByText("launch codes")).toHaveCount(0);

  // search and the global search page do not cross tenants
  const search = await (await page.request.get(`/api/orgs/${acme()}/search?q=Globex`)).json() as { tasks: unknown[]; projects: unknown[] };
  expect(search.tasks).toHaveLength(0);
  expect(search.projects).toHaveLength(0);
});

test("the globex administrator can see their own data (the isolation is not simply 'nothing works')", async ({ page }) => {
  await login(page, "boss@e2e.test");
  await page.goto(`/o/${globex()}/tasks`);
  await expect(page.getByRole("button", { name: "Globex secret plan", exact: true })).toBeVisible();
  const cross = await page.request.get(`/api/orgs/${acme()}/tasks`);
  expect(cross.status()).toBe(404);
});

test("state-changing requests from another origin are refused", async ({ page }) => {
  await login(page, "admin@e2e.test");
  const foreign = await page.request.post(`/api/orgs/${acme()}/departments`, { data: { name: "Evil" }, headers: { origin: "https://evil.example" } });
  expect(foreign.status()).toBe(403);
  // browsers always send Origin on non-GET fetches, so a request without one is not from our pages either
  const none = await page.request.post(`/api/orgs/${acme()}/departments`, { data: { name: "Evil" } });
  expect(none.status()).toBe(403);
  await page.goto(`/o/${acme()}/structure`);
  await expect(page.getByRole("heading", { name: "Structure", level: 1 })).toBeVisible();
  await expect(page.getByText("Evil", { exact: true })).toHaveCount(0);
});

test("two-factor: enrol, then sign-in needs the code; a backup code works once", async ({ page }) => {
  await register(page, "Tess Secure", "tess@e2e.test");
  await login(page, "tess@e2e.test");
  await page.goto("/security");
  await page.getByLabel("Confirm your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Enable two-factor" }).click();
  await expect(page.getByAltText("QR")).toBeVisible();
  const uri = (await page.locator("p.muted", { hasText: "otpauth://" }).textContent())!.trim();
  const backup = (await page.locator("pre").textContent())!.split("\n").map((s) => s.trim()).filter(Boolean);
  expect(backup.length).toBeGreaterThanOrEqual(5);

  // a wrong code does not enable it; the correct one does
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(alerts(page)).toBeVisible();
  await page.getByLabel("6-digit code").fill(await totpFromUri(uri));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("button", { name: "Disable" })).toBeVisible();

  // sign out; a password alone no longer gives a session
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await attemptLogin(page, "tess@e2e.test");
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(401);
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alerts(page)).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(401);
  await page.getByLabel("6-digit code").fill(await totpFromUri(uri));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  expect((await page.request.get("/api/me")).status()).toBe(200);

  // sign out and use a backup code instead of the authenticator
  await page.request.post("/api/auth/sign-out", { data: {}, headers: { origin: ORIGIN } });
  await attemptLogin(page, "tess@e2e.test");
  await page.getByRole("button", { name: "Use a backup code instead" }).click();
  await page.getByLabel("Backup code").fill(backup[0]!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // ... and the same backup code cannot be used a second time
  await page.request.post("/api/auth/sign-out", { data: {}, headers: { origin: ORIGIN } });
  await attemptLogin(page, "tess@e2e.test");
  await page.getByRole("button", { name: "Use a backup code instead" }).click();
  await page.getByLabel("Backup code").fill(backup[0]!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alerts(page)).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(401);
});

test("sessions: another device can be signed out remotely", async ({ browser }) => {
  const a = await browser.newContext(); const b = await browser.newContext();
  for (const ctx of [a, b]) await ctx.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const pa = await a.newPage(); const pb = await b.newPage();
  await login(pa, "admin@e2e.test");
  await login(pb, "admin@e2e.test");
  expect((await pb.request.get("/api/me")).status()).toBe(200);
  await pa.goto("/security");
  await pa.getByRole("button", { name: "Sign out other devices" }).click();
  await expect.poll(async () => (await pb.request.get("/api/me")).status()).toBe(401);
  expect((await pa.request.get("/api/me")).status()).toBe(200);
  await a.close(); await b.close();
});
