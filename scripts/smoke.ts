/**
 * Post-deployment smoke test over HTTP (docs/DEPLOYMENT.md). Read-only; needs no user account.
 *
 *   APP_URL=https://tasks.example.com CRON_SECRET=... pnpm smoke
 *
 * It checks that the deployed build is alive, wired to a migrated database whose runtime role enforces row-level
 * security, sends the security headers, and refuses unauthenticated and cross-origin access.
 */
const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
const cron = process.env.CRON_SECRET;
if (!base) { console.error("APP_URL is required"); process.exit(2); }

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const get = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init });

async function main() {
  const https = base.startsWith("https://");
  const local = /\/\/(localhost|127\.0\.0\.1)/.test(base);
  check("the site is served over HTTPS", https || local, base);

  const live = await get("/api/health");
  check("liveness endpoint answers", live.status === 200 && (await live.json() as { status?: string }).status === "ok");

  if (cron) {
    const ready = await get("/api/health/ready", { headers: { authorization: `Bearer ${cron}` } });
    const body = (await ready.json().catch(() => ({}))) as { status?: string; checks?: Record<string, { ok: boolean; detail?: string | number }> };
    check("readiness: database reachable", !!body.checks?.database?.ok);
    check("readiness: runtime role enforces row-level security", !!body.checks?.rowLevelSecurity?.ok, String(body.checks?.rowLevelSecurity?.detail ?? ""));
    check("readiness: database schema matches this build", !!body.checks?.migrations?.ok, String(body.checks?.migrations?.detail ?? ""));
    check("readiness: background jobs healthy", !!body.checks?.jobs?.ok, String(body.checks?.jobs?.detail ?? "")); // not fatal for go-live, but investigate
    const unauth = await get("/api/health/ready");
    check("readiness requires the secret", unauth.status === 401);
    const cronUnauth = await get("/api/cron/tick");
    check("the cron endpoint refuses callers without the secret", cronUnauth.status === 401);
  } else {
    console.log("SKIP  readiness and cron checks (CRON_SECRET not set)");
  }

  const login = await get("/login");
  const h = login.headers;
  const csp = h.get("content-security-policy") ?? "";
  check("login page loads", login.status === 200);
  check("CSP uses a per-request nonce and no unsafe-inline scripts", /script-src[^;]*'nonce-[^']+'/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp));
  check("framing is denied", h.get("x-frame-options") === "DENY" && csp.includes("frame-ancestors 'none'"));
  check("content-type sniffing is disabled", h.get("x-content-type-options") === "nosniff");
  check("the framework does not advertise itself", h.get("x-powered-by") === null);
  if (https) check("HSTS is sent", (h.get("strict-transport-security") ?? "").includes("max-age="));

  check("API requires authentication", (await get("/api/me")).status === 401);
  check("organization data requires authentication", (await get("/api/orgs/00000000-0000-4000-8000-000000000000/tasks")).status === 401);
  const cross = await get("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ email: "a@b.c", password: "x".repeat(12) }) });
  check("cross-origin sign-in attempts are refused", cross.status >= 400, `status ${cross.status}`);
  const write = await get("/api/orgs/00000000-0000-4000-8000-000000000000/departments", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
  check("cross-origin writes are refused", write.status === 403);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED"}: ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("smoke test crashed:", e instanceof Error ? e.message : e); process.exit(2); });
