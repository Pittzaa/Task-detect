import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { login, preferEnglish, register, state } from "./helpers";

/**
 * One installation is one organization; its administrators decide whether new people may sign up, and they may delete
 * departments, teams and projects. Runs last: the fixture bootstrapped two organizations, and this spec retires one.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const acme = () => state().acme.orgId;
const ORIGIN = "http://localhost:3100";
const SUPERUSER = process.env.E2E_DB_SUPERUSER_URL ?? "postgres://postgres@127.0.0.1:54329/tasktracker_e2e";

async function sql(text: string) {
  const c = new pg.Client({ connectionString: SUPERUSER });
  await c.connect();
  try { return await c.query(text); } finally { await c.end(); }
}
const post = (page: Page, path: string, data: unknown) => page.request.post(path, { data, headers: { origin: ORIGIN } });
const region = (page: Page, name: string) => page.getByRole("region", { name });

test.describe("registration switch", () => {
  test("with a single organization nobody is asked for an organization code", async ({ page }) => {
    await sql(`update organizations set deleted_at = now() where slug = 'globex'`);
    await register(page, "Wanda Wanderer", "wanderer@e2e.test");
    await login(page, "wanderer@e2e.test");
    await page.goto("/join");
    await expect(page.getByLabel("Organization code")).toHaveCount(0);
    await expect(page.getByText("Ask to join this workspace")).toBeVisible();
  });

  test("an administrator closes registration; strangers are told, people with an invitation still get in", async ({ page, browser }) => {
    await login(page, "admin@e2e.test");
    await page.goto(`/o/${acme()}/settings`);
    await page.getByRole("tab", { name: "General" }).click();
    const sw = page.getByRole("switch", { name: /Allow new people to sign up/ });
    await expect(sw).toBeChecked();
    await sw.uncheck();
    await expect(page.getByText("Nobody new can sign up or ask to join.")).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "General" }).click();
    await expect(page.getByRole("switch", { name: /Allow new people to sign up/ })).not.toBeChecked();

    // invite one address while it is closed
    const roles = (await (await page.request.get(`/api/orgs/${acme()}/roles`)).json()) as { roles: { id: string; key: string }[] };
    const invited = await post(page, `/api/orgs/${acme()}/invitations`, { email: "latecomer@e2e.test", roleId: roles.roles.find((r) => r.key === "viewer")!.id });
    expect(invited.status()).toBe(201);

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
    const anon = await ctx.newPage();
    await anon.goto("/register");
    await expect(anon.getByText("New sign-ups are closed at the moment.")).toBeVisible();
    await anon.getByLabel("Name").fill("Stranger Danger");
    await anon.getByLabel("Email").fill("stranger2@e2e.test");
    await anon.getByLabel("Password").fill("correct-horse-battery-9");
    await anon.getByRole("button", { name: "Create account" }).click();
    await expect(anon.getByRole("alert").filter({ hasText: "New sign-ups are closed at the moment" })).toBeVisible();
    await expect(anon.getByText(/Check your email/i)).toHaveCount(0);
    await ctx.close();

    // someone who already has an account but no membership cannot ask to join either
    const ctx2 = await browser.newContext();
    await ctx2.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
    const wanderer = await ctx2.newPage();
    await login(wanderer, "wanderer@e2e.test");
    await wanderer.goto("/join");
    await expect(wanderer.getByText("not accepting new people right now")).toBeVisible();
    await expect(wanderer.getByRole("button", { name: "Request access" })).toBeDisabled();
    const direct = await wanderer.request.post("/api/access-requests", { data: {}, headers: { origin: ORIGIN } });
    expect(direct.status()).toBe(403);
    expect(await direct.json()).toMatchObject({ error: { code: "REGISTRATION_CLOSED" } });
    await ctx2.close();
  });

  test("the invited address can still register while registration is closed", async ({ page }) => {
    await register(page, "Larry Latecomer", "latecomer@e2e.test");
  });

  test("reopening lets a new person ask to join, and the administrator sees the request", async ({ page, browser }) => {
    await login(page, "admin@e2e.test");
    await page.goto(`/o/${acme()}/settings`);
    await page.getByRole("tab", { name: "General" }).click();
    await page.getByRole("switch", { name: /Allow new people to sign up/ }).check();
    await expect(page.getByText("Anyone who knows the address of this site")).toBeVisible();

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
    const w = await ctx.newPage();
    await login(w, "wanderer@e2e.test");
    await w.goto("/join");
    await expect(w.getByLabel("Organization code")).toHaveCount(0);
    await w.getByRole("button", { name: "Request access" }).click();
    await expect(w.getByText(/Request sent/)).toBeVisible();
    await ctx.close();

    await page.goto(`/o/${acme()}/members`);
    await expect(page.getByRole("heading", { name: /Waiting for approval/ })).toBeVisible();
    await expect(page.getByText("Wanda Wanderer")).toBeVisible();
  });

  test("only administrators see the setting", async ({ page }) => {
    await login(page, "sam@e2e.test");
    await page.goto(`/o/${acme()}/settings`);
    await expect(page.getByRole("tab", { name: "Notification settings" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "General" })).toHaveCount(0);
    const direct = await page.request.put(`/api/orgs/${acme()}/settings`, { data: { registrationOpen: false }, headers: { origin: ORIGIN } });
    expect(direct.status()).toBe(403);
  });
});

test.describe("deleting structure", () => {
  const ids: { dept?: string; team?: string; project?: string; task?: string } = {};

  test("an administrator deletes a team, then its department, then a project with its tasks", async ({ page }) => {
    await login(page, "admin@e2e.test");
    const dept = await (await post(page, `/api/orgs/${acme()}/departments`, { name: "Doomed department" })).json() as { id: string };
    const team = await (await post(page, `/api/orgs/${acme()}/teams`, { departmentId: dept.id, name: "Doomed team" })).json() as { id: string };
    const team2 = await (await post(page, `/api/orgs/${acme()}/teams`, { departmentId: dept.id, name: "Doomed team two" })).json() as { id: string };
    const project = await (await post(page, `/api/orgs/${acme()}/projects`, { name: "Doomed project" })).json() as { id: string };
    const task = await (await post(page, `/api/orgs/${acme()}/tasks`, { projectId: project.id, title: "Doomed task" })).json() as { id: string };
    Object.assign(ids, { dept: dept.id, team: team.id, project: project.id, task: task.id });
    expect(task.id).toBeTruthy();

    await page.goto(`/o/${acme()}/structure`);
    const teams = region(page, "Teams");
    const teamButton = teams.getByRole("button", { name: "Delete: Doomed team", exact: true });
    await expect(teamButton).toBeVisible();

    // cancelling the confirmation deletes nothing
    page.once("dialog", (d) => { void d.dismiss(); });
    await teamButton.click();
    await expect(teamButton).toBeVisible();

    // a team
    let asked = "";
    page.once("dialog", (d) => { asked = d.message(); void d.accept(); });
    await teamButton.click();
    await expect(teamButton).toHaveCount(0);
    expect(asked).toContain("Doomed team");
    expect((await page.request.get(`/api/orgs/${acme()}/teams`).then((r) => r.json()) as { teams: { id: string }[] }).teams.map((t) => t.id)).not.toContain(team.id);

    // a department takes the rest of its teams with it
    const depts = region(page, "Departments");
    page.once("dialog", (d) => { asked = d.message(); void d.accept(); });
    await depts.getByRole("button", { name: "Delete: Doomed department" }).click();
    await expect(depts.getByRole("button", { name: "Delete: Doomed department" })).toHaveCount(0);
    expect(asked).toContain("1 team");
    await expect(teams.getByRole("button", { name: "Delete: Doomed team two" })).toHaveCount(0);
    const live = await page.request.get(`/api/orgs/${acme()}/teams`).then((r) => r.json()) as { teams: { id: string }[] };
    expect(live.teams.map((t) => t.id)).not.toContain(team2.id);

    // a project, with its tasks
    const projects = region(page, "Projects");
    page.once("dialog", (d) => { asked = d.message(); void d.accept(); });
    await projects.getByRole("button", { name: "Delete: Doomed project" }).click();
    await expect(projects.getByRole("button", { name: "Delete: Doomed project" })).toHaveCount(0);
    expect(asked).toContain("ALL of its tasks");
    expect((await page.request.get(`/api/orgs/${acme()}/projects/${project.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/orgs/${acme()}/tasks/${task.id}`)).status()).toBe(404);
    // the rest is untouched
    await expect(projects.getByRole("button", { name: "Delete: Website", exact: true })).toBeVisible();
  });

  test("a deleted project and its tasks are gone from every view, and the deletions are in the audit log", async ({ page }) => {
    await login(page, "admin@e2e.test");
    const list = await page.request.get(`/api/orgs/${acme()}/tasks?limit=100`).then((r) => r.json()) as { items: { id: string; title: string }[] };
    expect(list.items.map((t) => t.title)).not.toContain("Doomed task");
    const search = await page.request.get(`/api/orgs/${acme()}/search?q=Doomed`).then((r) => r.json());
    expect(JSON.stringify(search)).not.toContain("Doomed");
    await page.goto(`/o/${acme()}/audit`);
    for (const action of ["project.delete", "department.delete", "team.delete"]) await expect(page.getByText(action).first()).toBeVisible();
  });

  test("people without the right see no delete buttons and the server refuses them anyway", async ({ page }) => {
    await login(page, "sam@e2e.test");
    await page.goto(`/o/${acme()}/structure`);
    await expect(page.getByRole("heading", { name: "Structure" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
    const some = await page.request.get(`/api/orgs/${acme()}/projects`).then((r) => r.json()) as { projects: { id: string }[] };
    expect(some.projects.length).toBeGreaterThan(0);
    const res = await page.request.delete(`/api/orgs/${acme()}/projects/${some.projects[0]!.id}`, { headers: { origin: ORIGIN } });
    expect([403, 404]).toContain(res.status());
    const still = await page.request.get(`/api/orgs/${acme()}/projects/${some.projects[0]!.id}`);
    expect(still.status()).toBe(200);
  });
});
