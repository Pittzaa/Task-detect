import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { login, state, preferEnglish } from "./helpers";

/**
 * Systematic sweep of EVERY API route in the repository (discovered from the file system, so a new route is covered
 * automatically): unauthenticated access, cross-tenant access with real ids, and malformed input. Runs against the real
 * server and database. The assertions are about classes of failure, not individual endpoints:
 *   - nothing is reachable without a session,
 *   - another tenant's administrator gets 403/404/422 and NEVER a 2xx for any method on any of our organization's routes,
 *   - no input, however malformed, produces a 5xx.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const ORIGIN = "http://localhost:3100";
const SUPER = "postgres://postgres@127.0.0.1:54329/tasktracker_e2e";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

interface Route { file: string; template: string; methods: Method[] }

function discover(): Route[] {
  const root = "src/app/api";
  const out: Route[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") {
        const src = readFileSync(full, "utf8");
        const methods = METHODS.filter((m) => new RegExp(`export (const|async function|function) ${m}\\b`).test(src));
        out.push({ file: full, template: "/api/" + path.relative(root, path.dirname(full)).split(path.sep).join("/"), methods });
      }
    }
  };
  walk(root);
  return out.map((r) => ({ ...r, template: r.template.replace(/\/$/, "") }));
}

const ROUTES = discover();
const PUBLIC = new Set(["/api/auth/[...all]", "/api/auth-config", "/api/health", "/api/health/ready", "/api/cron/tick", "/api/calendar/callback"]);
const ZERO = "00000000-0000-4000-8000-000000000000";

const fill = (template: string, ids: Record<string, string>, fallback: string) =>
  template.replace(/\[(\w+)\]/g, (_m, key: string) => ids[key] ?? fallback);

/** One real id of every kind from the ACME organization, read straight from the database. */
async function realIds(acme: string): Promise<Record<string, string>> {
  const c = new pg.Client({ connectionString: SUPER });
  await c.connect();
  try {
    const one = async (sql: string) => ((await c.query(sql, [acme])).rows[0]?.id as string | undefined) ?? ZERO;
    return {
      orgId: acme,
      taskId: await one(`select id from tasks where org_id = $1 and deleted_at is null limit 1`),
      projectId: await one(`select id from projects where org_id = $1 limit 1`),
      attachmentId: await one(`select id from attachments where org_id = $1 limit 1`),
      commentId: await one(`select id from comments where org_id = $1 limit 1`),
      fieldId: await one(`select id from custom_field_defs where org_id = $1 limit 1`),
      destinationId: await one(`select id from integration_destinations where org_id = $1 limit 1`),
      invitationId: await one(`select id from invitations where org_id = $1 limit 1`),
      membershipId: await one(`select id from memberships where org_id = $1 limit 1`),
      roleId: await one(`select id from roles where org_id = $1 or org_id is null limit 1`),
      seriesId: await one(`select id from recurrence_series where org_id = $1 limit 1`),
      viewId: await one(`select id from saved_views where org_id = $1 limit 1`),
      assignmentId: await one(`select id from role_assignments where org_id = $1 limit 1`),
    };
  } finally { await c.end(); }
}

async function call(req: APIRequestContext, method: Method, url: string, data?: unknown) {
  return req.fetch(url, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, data: data === undefined ? undefined : JSON.stringify(data), failOnStatusCode: false, maxRedirects: 0 });
}

test("seed: make sure the organization owns at least one row of every kind the sweep probes", async ({ page }) => {
  await login(page, "admin@e2e.test");
  const acme = state().acme.orgId;
  const projects = (await (await page.request.get(`/api/orgs/${acme}/projects`)).json()) as { projects: { id: string }[] };
  const fields = await call(page.request, "POST", `/api/orgs/${acme}/custom-fields`, { name: "Sweep field", type: "text" });
  expect([201, 409]).toContain(fields.status());
  const dest = await call(page.request, "POST", `/api/orgs/${acme}/integrations/discord`, {
    name: "Sweep channel", webhookUrl: `https://discord.com/api/webhooks/123456789012345678/${"S".repeat(40)}`, projectId: projects.projects[0]!.id, events: ["task.assigned"],
  });
  expect([201, 409]).toContain(dest.status());
  const ids = await realIds(acme);
  expect(Object.entries(ids).filter(([, v]) => v === ZERO).map(([k]) => k)).toEqual([]);
});

test("the sweep really covers the whole API (guards against the discovery silently finding nothing)", () => {
  expect(ROUTES.length).toBeGreaterThanOrEqual(55);
  const calls = ROUTES.reduce((n, r) => n + r.methods.length, 0);
  expect(calls).toBeGreaterThanOrEqual(90);
  expect(ROUTES.every((r) => r.methods.length > 0), ROUTES.filter((r) => !r.methods.length).map((r) => r.file).join(", ")).toBe(true);
});

test("unauthenticated: every non-public route refuses every method with 401 (and never 5xx)", async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: ORIGIN });
  const ids = await realIds(state().acme.orgId);
  const bad: string[] = [];
  let calls = 0;
  for (const r of ROUTES) {
    if (PUBLIC.has(r.template)) continue;
    for (const m of r.methods) {
      calls++;
      const res = await call(anon, m, fill(r.template, ids, ZERO), m === "GET" || m === "DELETE" ? undefined : {});
      if (res.status() !== 401) bad.push(`${m} ${r.template} → ${res.status()}`);
    }
  }
  await anon.dispose();
  expect(calls).toBeGreaterThan(80);
  expect(bad).toEqual([]);
});

test("public routes behave: cron and readiness refuse without the secret, callback and auth config never 5xx", async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: ORIGIN });
  expect((await call(anon, "GET", "/api/cron/tick")).status()).toBe(401);
  expect((await call(anon, "GET", "/api/health/ready")).status()).toBe(401);
  expect((await call(anon, "GET", "/api/health")).status()).toBe(200);
  expect((await call(anon, "GET", "/api/auth-config")).status()).toBe(200);
  for (const q of ["", "?code=x&state=y", "?error=access_denied", "?state=" + "a".repeat(5000)]) {
    const r = await call(anon, "GET", "/api/calendar/callback" + q);
    expect(r.status(), q.slice(0, 40)).toBeLessThan(500);
  }
  await anon.dispose();
});

test("cross-tenant: another organization's administrator can reach NOTHING of ours, on any route and method", async ({ page }) => {
  await login(page, "boss@e2e.test"); // administrator of the other organization (globex)
  const ids = await realIds(state().acme.orgId);
  expect(Object.values(ids).filter((v) => v === ZERO)).toEqual([]); // every kind of id exists, so the probes are real
  const leaks: string[] = [];
  const server: string[] = [];
  let calls = 0;
  for (const r of ROUTES) {
    if (!r.template.includes("[orgId]")) continue;
    for (const m of r.methods) {
      calls++;
      const url = fill(r.template, ids, ZERO);
      const res = await call(page.request, m, url, m === "GET" || m === "DELETE" ? undefined : {});
      const s = res.status();
      if (s >= 500) server.push(`${m} ${r.template} → ${s}`);
      if (s < 400 || s === 409) leaks.push(`${m} ${r.template} → ${s}`);
      const body = await res.text();
      // acme's data must not appear in any answer
      if (/Design the homepage|Sprint planning|Weekly status|admin@e2e\.test|sam@e2e\.test/.test(body)) leaks.push(`${m} ${r.template} leaked content`);
    }
  }
  expect(calls).toBeGreaterThan(60);
  expect(server).toEqual([]);
  expect(leaks).toEqual([]);
});

test("cross-tenant: a viewer of our own organization cannot use any state-changing route that needs more than viewer rights", async ({ page }) => {
  await login(page, "sam@e2e.test"); // viewer in acme
  const ids = await realIds(state().acme.orgId);
  const allowedForViewer = new Set([
    // reads and personal settings a viewer is entitled to
    "GET",
  ]);
  const wrote: string[] = [];
  const server: string[] = [];
  for (const r of ROUTES) {
    if (!r.template.includes("[orgId]")) continue;
    for (const m of r.methods) {
      if (allowedForViewer.has(m)) continue;
      // personal, self-service routes are legitimately open to any member
      if (/\/notification(s|-settings)$|\/views(\/\[viewId\](\/run)?)?$|\/calendar(\/(connect|resync))?$/.test(r.template)) continue;
      const res = await call(page.request, m, fill(r.template, ids, ZERO), {});
      if (res.status() >= 500) server.push(`${m} ${r.template} → ${res.status()}`);
      if (res.status() < 400) wrote.push(`${m} ${r.template} → ${res.status()}`);
    }
  }
  expect(server).toEqual([]);
  expect(wrote).toEqual([]);
});

test("robustness: malformed ids, bodies and query strings never produce a 5xx (as an administrator of the organization)", async ({ page }) => {
  await login(page, "admin@e2e.test");
  const acme = state().acme.orgId;
  const weirdIds = ["not-a-uuid", "'; drop table tasks; --", "%00", "..%2f..%2fetc%2fpasswd", "x".repeat(300), "００００", ZERO];
  const bodies: unknown[] = [{}, [], null, "string", 42, { title: "x".repeat(100_000) }, { a: { b: { c: { d: {} } } } }, { __proto__: { admin: true } }, { title: "a\u0000b" }];
  const failures: string[] = [];
  let calls = 0;
  for (const r of ROUTES) {
    if (PUBLIC.has(r.template)) continue;
    for (const m of r.methods) {
      for (const wid of weirdIds) {
        const url = r.template.replace(/\[orgId\]/g, acme).replace(/\[\w+\]/g, encodeURIComponent(wid).replace(/%25/g, "%"));
        calls++;
        const sendBody = m !== "GET" && m !== "DELETE";
        const res = await call(page.request, m, url, sendBody ? bodies[calls % bodies.length] : undefined);
        if (res.status() >= 500) failures.push(`${m} ${r.template} [${wid.slice(0, 20)}] → ${res.status()}`);
      }
    }
  }
  // raw invalid JSON and wrong content types on every writing route
  for (const r of ROUTES) {
    if (PUBLIC.has(r.template) || r.template.endsWith("/attachments")) continue;
    for (const m of r.methods.filter((x) => x !== "GET" && x !== "DELETE")) {
      calls++;
      const res = await page.request.fetch(r.template.replace(/\[orgId\]/g, acme).replace(/\[\w+\]/g, ZERO), { method: m, headers: { origin: ORIGIN, "content-type": "application/json" }, data: "{not json", failOnStatusCode: false });
      if (res.status() >= 500) failures.push(`${m} ${r.template} (invalid json) → ${res.status()}`);
    }
  }
  expect(calls).toBeGreaterThan(500);
  expect(failures).toEqual([]);
});

test("robustness: query strings with hostile or extreme values on every list endpoint never produce a 5xx or a huge answer", async ({ page }) => {
  await login(page, "admin@e2e.test");
  const acme = state().acme.orgId;
  const ids = await realIds(acme);
  const queries = [
    "?limit=-1", "?limit=0", "?limit=999999999", "?limit=abc", "?offset=-5", "?offset=99999999999999999999", "?q=" + "%25".repeat(200), "?q=%00", "?q=" + "a".repeat(5000),
    "?sort=;drop table tasks", "?status=nope", "?status=todo,,,,", "?priority[]=high", "?assignee=not-a-uuid", "?projectId=not-a-uuid", "?from=2026-13-45&to=abc", "?dueFrom=9999-99-99",
    "?custom.x=1", "?label=%27%20OR%201%3D1", "?order=sideways", "?task=" + ZERO,
  ];
  const failures: string[] = [];
  let calls = 0;
  for (const r of ROUTES) {
    if (PUBLIC.has(r.template) || !r.methods.includes("GET")) continue;
    for (const q of queries) {
      calls++;
      const res = await call(page.request, "GET", fill(r.template, ids, ZERO) + q);
      if (res.status() >= 500) failures.push(`GET ${r.template}${q.slice(0, 30)} → ${res.status()}`);
      else if ((await res.body()).length > 2_000_000) failures.push(`GET ${r.template}${q.slice(0, 30)} → body too large`);
    }
  }
  expect(calls).toBeGreaterThan(400);
  expect(failures).toEqual([]);
});

test("robustness: text fields reject control characters and oversize values cleanly (422), never with a server error", async ({ page }) => {
  await login(page, "admin@e2e.test");
  const acme = state().acme.orgId;
  const ids = await realIds(acme);
  const bad = "a\u0000b";
  const cases: [Method, string, unknown][] = [
    ["POST", `/api/orgs/${acme}/tasks`, { projectId: ids.projectId, title: bad }],
    ["POST", `/api/orgs/${acme}/tasks`, { projectId: ids.projectId, title: "ok", description: bad }],
    ["PATCH", `/api/orgs/${acme}/tasks/${ids.taskId}`, { version: 1, title: bad }],
    ["POST", `/api/orgs/${acme}/tasks/${ids.taskId}/comments`, { body: bad }],
    ["POST", `/api/orgs/${acme}/departments`, { name: bad }],
    ["POST", `/api/orgs/${acme}/projects`, { name: bad }],
    ["POST", `/api/orgs/${acme}/labels`, { name: bad }],
    ["POST", `/api/orgs/${acme}/custom-fields`, { name: bad, type: "text" }],
    ["POST", `/api/orgs/${acme}/invitations`, { email: "a\u0000@b.test", roleId: ids.roleId }],
    ["POST", `/api/orgs/${acme}/views`, { name: bad, kind: "list", scope: "personal", filter: {} }],
    ["POST", `/api/orgs/${acme}/series`, { projectId: ids.projectId, title: bad, rule: { freq: "daily", interval: 1 }, startDate: "2030-01-01" }],
    ["POST", `/api/orgs/${acme}/roles`, { key: "r" + bad, name: bad, permissions: [] }],
    ["PATCH", `/api/me`, { name: bad }],
    ["PATCH", `/api/me`, { timezone: "Not/AZone" }],
    ["GET", `/api/orgs/${acme}/tasks?q=%00`, undefined],
    ["GET", `/api/orgs/${acme}/search?q=a%00b`, undefined],
    ["POST", `/api/access-requests`, { orgSlug: bad }],
    ["POST", `/api/auth/sign-up/email`, { name: bad, email: "nul-test@e2e.test", password: "correct-horse-battery-9" }],
    ["POST", `/api/auth/sign-in/email`, { email: "a\u0000@b.test", password: "x".repeat(12) }],
    ["POST", `/api/auth/request-password-reset`, { email: "a\u0000@b.test", redirectTo: "/reset-password" }],
  ];
  const failures: string[] = [];
  for (const [m, url, body] of cases) {
    const res = await call(page.request, m, url, body);
    // a clean client error: 4xx (422 for control characters)
    if (res.status() < 400 || res.status() >= 500) failures.push(`${m} ${url.replace(acme, ":org")} → ${res.status()} ${(await res.text()).slice(0, 80)}`);
  }
  expect(failures).toEqual([]);
});
