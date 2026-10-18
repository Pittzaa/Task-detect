import { expect, test } from "@playwright/test";
import { EXPECTED_MIGRATIONS } from "../../src/config/schema-version";
import { login, state, preferEnglish } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const acme = () => state().acme.orgId;
const CRON = "e2e-cron-secret-123456";

test.describe("browser security headers", () => {
  test("HTML pages carry a nonce-based CSP, a different nonce each time, and the standard hardening headers", async ({ request }) => {
    const a = await request.get("/login");
    const b = await request.get("/login");
    const cspA = a.headers()["content-security-policy"]!;
    const cspB = b.headers()["content-security-policy"]!;
    expect(cspA).toBeTruthy();
    const nonce = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce(cspA)).toBeTruthy();
    expect(nonce(cspA)).not.toBe(nonce(cspB));
    expect(cspA).toMatch(/script-src [^;]*'strict-dynamic'/);
    expect(cspA).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(cspA).not.toMatch(/script-src [^;]*'unsafe-eval'/);
    expect(cspA).toContain("frame-ancestors 'none'");
    expect(cspA).toContain("object-src 'none'");
    // the nonce in the header is the one the server put on its own scripts
    const html = await a.text();
    expect(html).toContain(`nonce="${nonce(cspA)}"`);

    const h = a.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("the strict policy does not break the app: pages hydrate and no CSP violation is reported", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => { if (/content security policy|refused to (execute|apply|load)/i.test(m.text())) violations.push(m.text()); });
    page.on("pageerror", (e) => violations.push(`pageerror: ${e.message}`));
    await login(page, "admin@e2e.test");
    for (const path of ["/my-tasks", "/tasks", "/tasks?view=board", "/tasks?view=calendar", "/tasks?view=timeline", "/dashboard", "/members", "/structure", "/settings", "/audit"]) {
      await page.goto(`/o/${acme()}${path}`);
      await expect(page.getByRole("heading", { level: 1 }).or(page.getByRole("heading", { level: 2 })).first()).toBeVisible();
    }
    await page.goto("/security");
    await expect(page.getByRole("heading", { name: "Security", level: 1 })).toBeVisible();
    // interactive behaviour (React event handlers, inline styles) still works under the policy
    await page.goto(`/o/${acme()}/tasks`);
    await page.getByRole("button", { name: /New task/ }).click();
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test("markup injected into the page cannot run script: inline event handlers and javascript: links are blocked", async ({ page }) => {
    // 'strict-dynamic' deliberately lets already-trusted scripts create scripts; what the policy must stop is *markup*
    // (the shape of a stored or reflected XSS): inline handlers and javascript: URLs.
    await page.goto("/login");
    const violations: string[] = [];
    page.on("console", (m) => { if (/content security policy/i.test(m.text())) violations.push(m.text()); });
    await page.evaluate(() => {
      (window as unknown as { __pwned?: boolean }).__pwned = false;
      document.body.insertAdjacentHTML("beforeend", '<img id="x1" src="/definitely-missing.png" onerror="window.__pwned = true">');
      document.body.insertAdjacentHTML("beforeend", '<a id="x2" href="javascript:window.__pwned = true">go</a>');
    });
    await page.locator("#x2").click();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBe(false);
    expect(violations.length).toBeGreaterThanOrEqual(1); // the browser reported the blocked attempts
  });

  test("the page cannot be framed", async ({ page }) => {
    await page.goto("/login");
    const framed = await page.evaluate(() => new Promise<boolean>((resolve) => {
      const f = document.createElement("iframe");
      f.src = "/login";
      f.onload = () => { try { resolve(!!f.contentDocument?.body?.innerHTML); } catch { resolve(false); } };
      document.body.appendChild(f);
      setTimeout(() => resolve(false), 1500);
    }));
    expect(framed).toBe(false);
  });
});

test.describe("health and traceability", () => {
  test("liveness is public and reveals nothing; readiness needs the secret and reports real checks", async ({ request }) => {
    const live = await request.get("/api/health");
    expect(live.status()).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });

    expect((await request.get("/api/health/ready")).status()).toBe(401);
    expect((await request.get("/api/health/ready", { headers: { authorization: "Bearer wrong-wrong-wrong-wrong" } })).status()).toBe(401);
    const ready = await request.get("/api/health/ready", { headers: { authorization: `Bearer ${CRON}` } });
    expect(ready.status()).toBe(200);
    const body = (await ready.json()) as { status: string; checks: Record<string, { ok: boolean; detail?: string | number }> };
    expect(body.checks.database!.ok).toBe(true);
    expect(body.checks.rowLevelSecurity!.ok).toBe(true);
    expect(body.checks.migrations).toMatchObject({ ok: true, detail: EXPECTED_MIGRATIONS });
    expect(["ok", "degraded"]).toContain(body.status);
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\/|password|secret/i);
  });

  test("API responses carry a request id; a harmless caller id is echoed, a hostile one is replaced", async ({ page }) => {
    await login(page, "admin@e2e.test");
    const plain = await page.request.get("/api/me");
    expect(plain.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await page.request.get("/api/me", { headers: { "x-request-id": "trace-abc12345" } });
    expect(echoed.headers()["x-request-id"]).toBe("trace-abc12345");
    const hostile = await page.request.get("/api/me", { headers: { "x-request-id": "<script>alert(1)</script>" } });
    expect(hostile.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const unauth = await page.context().request.get("/api/orgs/" + acme() + "/tasks", { headers: { cookie: "" } });
    expect(unauth.headers()["x-request-id"]).toBeTruthy();
  });
});

test.describe("rate limits", () => {
  test("search is limited per user and answers 429 RATE_LIMITED without leaking anything", async ({ page }) => {
    await login(page, "sam@e2e.test");
    const url = `/api/orgs/${acme()}/search?q=Sprint`;
    let first429 = 0;
    for (let i = 1; i <= 130; i++) {
      const r = await page.request.get(url);
      if (r.status() === 429) { first429 = i; expect(((await r.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED"); break; }
      expect(r.status()).toBe(200);
    }
    expect(first429).toBeGreaterThan(100); // generous for humans...
    expect(first429).toBeLessThanOrEqual(125); // ...but bounded
  });

  test("the limit is per user: another account is unaffected by someone else exhausting theirs", async ({ page }) => {
    await login(page, "admin@e2e.test");
    expect((await page.request.get(`/api/orgs/${acme()}/search?q=Sprint`)).status()).toBe(200);
  });
});
