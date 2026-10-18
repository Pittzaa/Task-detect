import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PASSWORD, attemptLogin, linkIn, login, mails, register, state, preferEnglish, waitMail } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => { await preferEnglish(page); });

const ORIGIN = "http://localhost:3100";
const acme = () => state().acme.orgId;

test("sign-in never redirects to another site, whatever the `next` parameter says", async ({ page }) => {
  const hostile = ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "/%2f%2fevil.example", "////evil.example", "data:text/html,boo",
    // browsers drop tab, line feed and carriage return while parsing, so these read as "//evil.example"
    "/\t/evil.example/x", "/\n/evil.example/x", "/\r/evil.example/x"];
  for (const next of hostile) {
    await page.context().clearCookies();
    await preferEnglish(page);
    await attemptLogin(page, "sam@e2e.test", next);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => new URL(page.url()).pathname).not.toBe("/login");
    expect(new URL(page.url()).origin, `next=${next}`).toBe(ORIGIN);
  }
});

test("suspending a member cuts off their existing session on the very next request, and reactivating restores it", async ({ browser }) => {
  const adminCtx = await browser.newContext(); const samCtx = await browser.newContext();
  for (const c of [adminCtx, samCtx]) await c.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const admin = await adminCtx.newPage(); const sam = await samCtx.newPage();
  await login(admin, "admin@e2e.test");
  await login(sam, "sam@e2e.test");
  expect((await sam.request.get(`/api/orgs/${acme()}/tasks`)).status()).toBe(200);

  const members = (await (await admin.request.get(`/api/orgs/${acme()}/members`)).json()) as { members: { id: string; email: string }[] };
  const samId = members.members.find((m) => m.email === "sam@e2e.test")!.id;
  const set = (status: string) => admin.request.post(`/api/orgs/${acme()}/members/${samId}/status`, { data: { status }, headers: { origin: ORIGIN } });
  try {
    expect((await set("suspended")).status()).toBe(200);
    for (const url of [`/api/orgs/${acme()}/tasks`, `/api/orgs/${acme()}/context`, `/api/orgs/${acme()}/notifications`, `/api/orgs/${acme()}/dashboard`, `/api/orgs/${acme()}/projects`]) {
      expect((await sam.request.get(url)).status(), url).toBe(404);
    }
    await sam.goto(`/o/${acme()}/tasks`);
    await expect(sam.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("Not found");
    expect((await sam.request.get("/api/me")).status()).toBe(200); // the account itself is fine; only the membership is suspended
  } finally {
    expect((await set("approved")).status()).toBe(200); // never leave the shared account suspended for the next test
  }
  expect((await sam.request.get(`/api/orgs/${acme()}/tasks`)).status()).toBe(200);
  await adminCtx.close(); await samCtx.close();
});

test("removing a role assignment takes effect immediately, without signing out", async ({ browser }) => {
  const adminCtx = await browser.newContext(); const samCtx = await browser.newContext();
  for (const c of [adminCtx, samCtx]) await c.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const admin = await adminCtx.newPage(); const sam = await samCtx.newPage();
  await login(admin, "admin@e2e.test");
  await login(sam, "sam@e2e.test");
  const members = (await (await admin.request.get(`/api/orgs/${acme()}/members`)).json()) as { members: { id: string; email: string; roles: { id: string; roleKey: string }[] }[] };
  const me = members.members.find((m) => m.email === "sam@e2e.test")!;
  const assignment = me.roles[0]!;
  expect((await sam.request.get(`/api/orgs/${acme()}/tasks`)).status()).toBe(200);
  const del = await admin.request.delete(`/api/orgs/${acme()}/assignments/${assignment.id}`, { headers: { origin: ORIGIN } });
  expect(del.status()).toBe(200);
  const tasks = await sam.request.get(`/api/orgs/${acme()}/tasks`);
  expect(tasks.status()).toBe(200);
  expect(((await tasks.json()) as { items: unknown[] }).items).toHaveLength(0); // member with no role sees nothing
  // put the viewer role back for the rest of the suite
  const roles = (await (await admin.request.get(`/api/orgs/${acme()}/roles`)).json()) as { roles: { id: string; key: string }[] };
  const viewer = roles.roles.find((r) => r.key === assignment.roleKey)!;
  const back = await admin.request.post(`/api/orgs/${acme()}/assignments`, { data: { membershipId: me.id, roleId: viewer.id, scope: { type: "organization" } }, headers: { origin: ORIGIN } });
  expect(back.status()).toBeLessThan(300);
  expect(((await (await sam.request.get(`/api/orgs/${acme()}/tasks`)).json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  await adminCtx.close(); await samCtx.close();
});

test("resetting a password signs out every other session, and the old password stops working", async ({ browser }) => {
  const a = await browser.newContext(); const b = await browser.newContext();
  for (const c of [a, b]) await c.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const pa = await a.newPage(); const pb = await b.newPage();
  await register(pa, "Pat Reset", "pat@e2e.test");
  await login(pa, "pat@e2e.test");
  await login(pb, "pat@e2e.test");
  expect((await pb.request.get("/api/me")).status()).toBe(200);

  // reset from a third, signed-out browser
  const c3 = await browser.newContext();
  await c3.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const p3 = await c3.newPage();
  const before = mails().length;
  await p3.goto("/forgot-password");
  await p3.getByLabel("Email").fill("pat@e2e.test");
  await p3.getByRole("button", { name: "Send reset link" }).click();
  const mail = await waitMail("pat@e2e.test", /reset-password/, before);
  await p3.goto(linkIn(mail));
  await p3.getByLabel("New password").fill("a-brand-new-passphrase-42");
  await p3.getByRole("button", { name: "Save" }).click();
  await expect(p3).toHaveURL(/\/login/);

  expect((await pa.request.get("/api/me")).status(), "session of the first browser").toBe(401);
  expect((await pb.request.get("/api/me")).status(), "session of the second browser").toBe(401);
  // the old password is dead, the new one works, and the link cannot be used twice
  await attemptLogin(p3, "pat@e2e.test");
  await expect(p3.getByRole("alert").filter({ hasText: /sign in|password/i }).first()).toBeVisible();
  const oldPassword = PASSWORD;
  expect(oldPassword).not.toBe("a-brand-new-passphrase-42");
  const res = await p3.request.post("/api/auth/sign-in/email", { data: { email: "pat@e2e.test", password: "a-brand-new-passphrase-42" }, headers: { origin: ORIGIN } });
  expect(res.status()).toBe(200);
  const reuse = await p3.request.post("/api/auth/reset-password", { data: { newPassword: "another-new-passphrase-43", token: new URL(linkIn(mail)).searchParams.get("token") }, headers: { origin: ORIGIN } });
  expect(reuse.status()).toBeGreaterThanOrEqual(400);
  await a.close(); await b.close(); await c3.close();
});

test("a signed-in user changes their password from the Security page and other devices are signed out", async ({ browser }) => {
  const a = await browser.newContext(); const b = await browser.newContext();
  for (const c of [a, b]) await c.addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);
  const pa = await a.newPage(); const pb = await b.newPage();
  await register(pa, "Quin Change", "quin@e2e.test");
  await login(pa, "quin@e2e.test");
  await login(pb, "quin@e2e.test");
  await pa.goto("/security");
  const form = pa.getByRole("region", { name: "Change password" });

  await form.getByLabel("Current password").fill("this-is-not-it-123");
  await form.getByLabel("New password", { exact: true }).fill("quin-new-passphrase-1");
  await form.getByLabel("Repeat the new password").fill("quin-new-passphrase-1");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByText("The current password is not correct.")).toBeVisible();

  await form.getByLabel("Current password").fill(PASSWORD);
  await form.getByLabel("Repeat the new password").fill("something-else-entirely");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByText("The two new passwords are different.")).toBeVisible();

  await form.getByLabel("Repeat the new password").fill("quin-new-passphrase-1");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByText("Password changed.").first()).toBeVisible();
  await expect(form.getByLabel("Current password")).toHaveValue(""); // fields are cleared
  expect((await pa.request.get("/api/me")).status()).toBe(200); // this device stays signed in
  expect((await pb.request.get("/api/me")).status()).toBe(401); // the other one does not
  const old = await pa.request.post("/api/auth/sign-in/email", { data: { email: "quin@e2e.test", password: PASSWORD }, headers: { origin: ORIGIN } });
  expect(old.status()).toBe(401);
  const fresh = await pa.request.post("/api/auth/sign-in/email", { data: { email: "quin@e2e.test", password: "quin-new-passphrase-1" }, headers: { origin: ORIGIN } });
  expect(fresh.status()).toBe(200);
  await a.close(); await b.close();
});

test("a user downloads their data and then erases their account from the Security page", async ({ page }) => {
  await register(page, "Rae Leaving", "rae@e2e.test");
  await login(page, "rae@e2e.test");
  await page.goto("/security");

  // the data export is a file download that names the user and holds no credentials
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download my data" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^my-data-\d{4}-\d{2}-\d{2}\.json$/);
  const text = readFileSync((await file.path())!, "utf8");
  const data = JSON.parse(text) as { profile: { email: string }; signIn: { providers: string[] } };
  expect(data.profile.email).toBe("rae@e2e.test");
  expect(data.signIn.providers).toEqual(["credential"]);
  expect(text).not.toMatch(/scrypt|\$argon|password":/i);

  const form = page.getByRole("region", { name: "Erase my account" });
  const erase = form.getByRole("button", { name: "Erase my account" });
  await expect(erase).toBeDisabled(); // nothing typed yet

  // a wrong e-mail address and a wrong password are both refused with a clear message, and nothing happens
  page.on("dialog", (d) => void d.accept());
  await form.getByLabel(/Type your e-mail address/).fill("someone@else.test");
  await form.getByLabel("Current password").fill(PASSWORD);
  await erase.click();
  await expect(form.getByText("The e-mail address does not match.")).toBeVisible();
  await form.getByLabel(/Type your e-mail address/).fill("rae@e2e.test");
  await form.getByLabel("Current password").fill("this-is-not-it-123");
  await erase.click();
  await expect(form.getByText("The current password is not correct.")).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(200);

  // the real thing
  await form.getByLabel("Current password").fill(PASSWORD);
  await erase.click();
  await expect(page).toHaveURL(/\/login\?erased=1/);
  await expect(page.getByText("Your account was erased.")).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(401);
  const again = await page.request.post("/api/auth/sign-in/email", { data: { email: "rae@e2e.test", password: PASSWORD }, headers: { origin: ORIGIN } });
  expect(again.status()).toBe(401);
});

test("cross-origin pages cannot read our API: no permissive CORS headers, preflights are not honoured", async ({ page, request }) => {
  await login(page, "admin@e2e.test");
  const withOrigin = await page.request.get("/api/me", { headers: { origin: "https://evil.example" } });
  expect(withOrigin.headers()["access-control-allow-origin"]).toBeUndefined();
  expect(withOrigin.headers()["access-control-allow-credentials"]).toBeUndefined();
  const pre = await request.fetch("/api/me", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" }, failOnStatusCode: false });
  expect(pre.headers()["access-control-allow-origin"]).toBeUndefined();
  expect(pre.status()).toBeLessThan(500);
});

test("an unknown address shows a friendly not-found page in the chosen language, with a way back", async ({ page }) => {
  const res = await page.goto("/no-such-page-here");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found", level: 1 })).toBeVisible();
  await expect(page.getByText(/Next\.js|stack|at .*\.js/)).toHaveCount(0);
  await page.getByRole("link", { name: "Back to start" }).click();
  await expect(page).not.toHaveURL(/no-such-page-here/);
});
