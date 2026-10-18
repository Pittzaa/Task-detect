import { parseArgs } from "node:util";
import { createDb } from "../src/db/client";
import { resetTwoFactor } from "../src/ops/reset-two-factor";

/**
 * Operator recovery for two-factor sign-in (see docs/ADMIN_GUIDE.md "If people are locked out of two-factor").
 *   pnpm auth:reset-2fa --email a@b.c          # one person: they sign in with the password and enrol again
 *   pnpm auth:reset-2fa --all --yes            # everyone (after BETTER_AUTH_SECRET was changed)
 * Uses DATABASE_URL (the application's runtime role). Each reset is written to the audit log of the person's organizations.
 */
const { values } = parseArgs({ options: { email: { type: "string" }, all: { type: "boolean" }, yes: { type: "boolean" } } });
if (!values.email === !values.all) throw new Error("usage: pnpm auth:reset-2fa --email <address>   or   pnpm auth:reset-2fa --all --yes");
if (values.all && !values.yes) throw new Error("--all resets two-factor for EVERY account that has it; add --yes to confirm");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (the application's runtime role)");

const { db, close } = createDb(url);
try {
  const done = await resetTwoFactor(db, values.all ? { all: true } : { email: values.email! });
  if (!done.length) console.log("nobody matched (nothing changed)");
  else console.log(`two-factor removed for ${done.length} account(s); they sign in with their password and can enrol again on the Security page:\n${done.map((d) => `  ${d.email}`).join("\n")}`);
} finally {
  await close();
}
