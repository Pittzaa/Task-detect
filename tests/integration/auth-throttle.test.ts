import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { accountRule, throttleAccount } from "@/server/auth-throttle";
import { POST } from "@/app/api/auth/[...all]/route";
import { Client, PASSWORD, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { connect } from "./helpers";

function base32Decode(input: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString("utf8");
}

const c = connect();
afterAll(() => c.close());

const BASE = "http://localhost:3000/api/auth";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const fresh = () => `victim-${randomUUID()}@example.test`;

async function attempts(n: number, make: () => Request) {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await throttleAccount(make(), c.app))?.status ?? 0);
  return codes;
}

describe("accountRule", () => {
  it("only applies to the sign-in, reset-request and two-factor routes", () => {
    expect(accountRule("/api/auth/sign-in/email", "a@b.c", null)?.key).toMatch(/^acct:signin:[0-9a-f]{64}$/);
    expect(accountRule("/api/auth/request-password-reset", "a@b.c", null)?.key).toMatch(/^acct:reset:/);
    expect(accountRule("/api/auth/sign-up/email", "a@b.c", null)).toBeNull();
    expect(accountRule("/api/auth/get-session", "a@b.c", null)).toBeNull();
    expect(accountRule("/api/auth/sign-in/email", undefined, null)).toBeNull();
  });
  it("never puts the e-mail address or the pending cookie into the stored key", () => {
    const k = accountRule("/api/auth/sign-in/email", "ana@example.com", null)!.key;
    expect(k).not.toContain("ana");
    const t = accountRule("/api/auth/two-factor/verify-totp", undefined, "x=1; __Secure-better-auth.two_factor=PENDING-TOKEN.sig; y=2")!.key;
    expect(t).not.toContain("PENDING");
  });
  it("finds the pending two-factor cookie with and without the production prefix, and ignores look-alikes", () => {
    const plain = accountRule("/api/auth/two-factor/verify-totp", undefined, "better-auth.two_factor=abc");
    const secure = accountRule("/api/auth/two-factor/verify-backup-code", undefined, "a=b; __Secure-better-auth.two_factor=abc");
    expect(plain?.key).toBeTruthy();
    expect(plain?.key).toBe(secure?.key);
    expect(accountRule("/api/auth/two-factor/verify-totp", undefined, "evil-better-auth.two_factor=abc")).toBeNull();
    expect(accountRule("/api/auth/two-factor/verify-totp", undefined, "better-auth.session_token=abc")).toBeNull();
    expect(accountRule("/api/auth/two-factor/verify-totp", undefined, null)).toBeNull();
  });
});

describe("throttleAccount", () => {
  it("stops sign-in attempts against one account after 20 in a window, whatever address they claim to come from", async () => {
    const email = fresh();
    let n = 0;
    const codes = await attempts(23, () => post("/sign-in/email", { email, password: "x" }, { "x-forwarded-for": `10.0.0.${n++ % 250}` }));
    expect(codes.slice(0, 20).every((s) => s === 0)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429, 429]);
  });

  it("answers in Better Auth's error shape, with Retry-After, and does not cache", async () => {
    const email = fresh();
    await attempts(20, () => post("/sign-in/email", { email, password: "x" }));
    const res = (await throttleAccount(post("/sign-in/email", { email, password: "x" }), c.app))!;
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ message: "Too many requests. Please try again later.", code: "RATE_LIMITED" });
    expect(res.headers.get("retry-after")).toBe("900");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("counts one account no matter how its address is written, and leaves other accounts alone", async () => {
    const email = fresh();
    const other = fresh();
    for (let i = 0; i < 20; i++) await throttleAccount(post("/sign-in/email", { email: i % 2 ? email.toUpperCase() : `  ${email} `, password: "x" }), c.app);
    expect((await throttleAccount(post("/sign-in/email", { email, password: "x" }), c.app))?.status).toBe(429);
    expect(await throttleAccount(post("/sign-in/email", { email: other, password: "x" }), c.app)).toBeNull();
  });

  it("limits password-reset e-mails to five an hour per address", async () => {
    const email = fresh();
    expect(await attempts(7, () => post("/request-password-reset", { email }))).toEqual([0, 0, 0, 0, 0, 429, 429]);
  });

  it("limits code guesses on one pending two-factor sign-in, and a new pending sign-in starts fresh", async () => {
    const cookie = `__Secure-better-auth.two_factor=${randomUUID()}.sig`;
    const codes = await attempts(12, () => post("/two-factor/verify-totp", { code: "000000" }, { cookie }));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 429, 429]);
    expect(await throttleAccount(post("/two-factor/verify-backup-code", { code: "x" }, { cookie }), c.app)).not.toBeNull(); // shared budget
    expect(await throttleAccount(post("/two-factor/verify-totp", { code: "000000" }, { cookie: `better-auth.two_factor=${randomUUID()}.sig` }), c.app)).toBeNull();
  });

  it("ignores everything else: reads, other routes, bodies that are not JSON or have no e-mail", async () => {
    expect(await throttleAccount(new Request(`${BASE}/sign-in/email`, { method: "GET" }), c.app)).toBeNull();
    expect(await throttleAccount(post("/sign-up/email", { email: fresh() }), c.app)).toBeNull();
    expect(await attempts(30, () => post("/sign-in/email", "not json"))).toEqual(Array(30).fill(0));
    expect(await attempts(30, () => post("/sign-in/email", { email: 42 }))).toEqual(Array(30).fill(0));
  });

  it("passes the request body on untouched for Better Auth to read", async () => {
    const req = post("/sign-in/email", { email: fresh(), password: "x" });
    await throttleAccount(req, c.app);
    expect((await req.json() as { password: string }).password).toBe("x");
  });
});

describe("the sign-in route itself", () => {
  it("is guarded: the 21st attempt on one account is refused before Better Auth sees it, earlier ones reach Better Auth", async () => {
    makeAuthApp(c.app, { rateLimit: false }); // Better Auth's own per-address limit off: only the account limit can answer 429
    const email = fresh();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await POST(post("/sign-in/email", { email, password: "wrong-password-123" }, { "x-forwarded-for": `10.1.0.${i}` }))).status);
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(0, 20).every((s) => s === 401 || s === 400)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});

describe("successful sign-ins do not use up the allowance", () => {
  it("only wrong guesses count: many correct sign-ins in a row are never refused, and the 21st wrong guess is", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { email } = await registerAndSignIn(app, "refund");
    const signIn = (password: string) => POST(post("/sign-in/email", { email, password }));
    const good: number[] = [];
    for (let i = 0; i < 30; i++) good.push((await signIn(PASSWORD)).status);
    expect(good).toEqual(Array(30).fill(200));

    const bad: number[] = [];
    for (let i = 0; i < 19; i++) bad.push((await signIn("wrong-password-123")).status);
    for (let i = 0; i < 5; i++) expect((await signIn(PASSWORD)).status).toBe(200); // correct ones in between are given back
    bad.push((await signIn("wrong-password-123")).status); // the 20th wrong guess is still answered by Better Auth
    expect(bad.every((s) => s === 401)).toBe(true);
    expect((await signIn("wrong-password-123")).status).toBe(429);
    expect((await signIn(PASSWORD)).status).toBe(429); // an exhausted allowance holds until the window ends, even for the right password
  });

  it("does not give back a password-reset request (the harm there is the e-mail itself)", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { email } = await registerAndSignIn(app, "reset-norefund");
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await POST(post("/request-password-reset", { email, redirectTo: "http://localhost:3000/reset" }))).status);
    expect(codes.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});

describe("against Better Auth's real two-factor sign-in", () => {
  it("the pending-sign-in cookie it sets is the one the limit looks for", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { client, email } = await registerAndSignIn(app, "mfa-throttle");
    const en = await client.authCall("POST", "/two-factor/enable", { password: PASSWORD });
    const { totpURI } = (await en.json()) as { totpURI: string };
    const { createOTP } = await import("@better-auth/utils/otp");
    await client.authCall("POST", "/two-factor/verify-totp", { code: await createOTP(base32Decode(new URL(totpURI).searchParams.get("secret")!)).totp() });

    const fresh = new Client(app.auth);
    const si = await fresh.authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    expect(((await si.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const cookieHeader = [...fresh.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    expect(accountRule("/api/auth/two-factor/verify-totp", undefined, cookieHeader)).not.toBeNull();
  });
});
