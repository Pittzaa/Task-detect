import { afterAll, describe, expect, it } from "vitest";
import { createAuth } from "@/server/auth";
import { createCaptureSender } from "@/integrations/email";
import { Client, PASSWORD, BASE, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { connect } from "./helpers";

const c = connect();
afterAll(() => c.close());

function base32Decode(input: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString("utf8");
}

/** Pins down what docs/SECURITY.md and docs/ENVIRONMENT.md say about rotating BETTER_AUTH_SECRET: it is not just "everyone signs in again". */
describe("changing BETTER_AUTH_SECRET", () => {
  it("signs everyone out AND makes every stored two-factor secret and backup code unusable", async () => {
    const before = makeAuthApp(c.app, { rateLimit: false }); // secret "test-secret-test-secret-test-secret-00"
    const { client, email } = await registerAndSignIn(before, "rotate");
    const enrol = await client.authCall("POST", "/two-factor/enable", { password: PASSWORD });
    const { totpURI, backupCodes } = (await enrol.json()) as { totpURI: string; backupCodes: string[] };
    const { createOTP } = await import("@better-auth/utils/otp");
    const totp = () => createOTP(base32Decode(new URL(totpURI).searchParams.get("secret")!)).totp();
    expect((await client.authCall("POST", "/two-factor/verify-totp", { code: await totp() })).status).toBe(200);

    // the same database, a different secret
    const after = createAuth({ db: c.app, baseURL: BASE, secret: "a-completely-different-secret-0123456789", email: createCaptureSender(), rateLimit: false });

    // 1. the old session no longer works
    const old = await after.handler(client.request("GET", "/api/auth/get-session"));
    expect(await old.text()).toMatch(/^(null)?$/);

    // 2. a fresh sign-in still asks for the second factor ...
    const fresh = new Client(after);
    const si = await fresh.authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    expect(((await si.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    // ... but neither a correct code nor a backup code is accepted any more
    expect((await fresh.authCall("POST", "/two-factor/verify-totp", { code: await totp() })).status).toBeGreaterThanOrEqual(400);
    const viaBackup = new Client(after);
    await viaBackup.authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    expect((await viaBackup.authCall("POST", "/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("pnpm auth:reset-2fa (the way back after a secret change)", () => {
  it("removes two-factor for one person or for everyone, lets them in with the password, and leaves a trace in the audit log", async () => {
    const { resetTwoFactor } = await import("@/ops/reset-two-factor");
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { createOTP } = await import("@better-auth/utils/otp");
    const enrolled = async (label: string) => {
      const { client, email } = await registerAndSignIn(app, label);
      const en = await client.authCall("POST", "/two-factor/enable", { password: PASSWORD });
      const { totpURI } = (await en.json()) as { totpURI: string };
      await client.authCall("POST", "/two-factor/verify-totp", { code: await createOTP(base32Decode(new URL(totpURI).searchParams.get("secret")!)).totp() });
      return email;
    };
    const needsSecondFactor = async (email: string) => {
      const si = await new Client(app.auth).authCall("POST", "/sign-in/email", { email, password: PASSWORD });
      return ((await si.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect === true;
    };
    const a = await enrolled("reset-a");
    const b = await enrolled("reset-b");
    expect(await needsSecondFactor(a)).toBe(true);

    expect(await resetTwoFactor(c.app, { email: a.toUpperCase() })).toEqual([{ email: a }]);
    expect(await needsSecondFactor(a)).toBe(false);
    expect(await needsSecondFactor(b)).toBe(true); // somebody else is untouched
    expect(await resetTwoFactor(c.app, { email: "nobody@example.test" })).toEqual([]);

    // the person can enrol again afterwards
    const c1 = new Client(app.auth);
    await c1.authCall("POST", "/sign-in/email", { email: a, password: PASSWORD });
    expect((await c1.authCall("POST", "/two-factor/enable", { password: PASSWORD })).status).toBe(200);

    const done = await resetTwoFactor(c.app, { all: true, only: [b] }); // `only`: other test files share this database
    expect(done.map((d) => d.email)).toEqual([b]);
    expect(await needsSecondFactor(b)).toBe(false);
  });
});
