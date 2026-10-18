import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import { eraseAccount, exportMyData } from "../src/data/privacy";

/**
 * Operator tool for data-subject requests when the person cannot use the Security page.
 *   pnpm privacy export --email a@b.c [--out file.json]
 *   pnpm privacy erase  --email a@b.c [--abandon] --yes
 * The operator is trusted to have verified who is asking. The same safety rules as in the UI apply (sole administrators and
 * platform administrators are refused; an organization left without members needs --abandon).
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { email: { type: "string" }, out: { type: "string" }, abandon: { type: "boolean" }, yes: { type: "boolean" } },
});
const [command] = positionals;
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required — use the application's runtime role");
if ((command !== "export" && command !== "erase") || !values.email) {
  throw new Error("usage: pnpm privacy <export|erase> --email <address> [--out file] [--abandon] [--yes]");
}

const { db, close } = createDb(url);
try {
  // Looking a user up by e-mail is the one thing the runtime role may do without a tenant context (users carry no row-level security).
  const [u] = await db.select({ id: users.id, email: users.email, deletedAt: users.deletedAt }).from(users).where(sql`lower(${users.email}) = ${values.email.trim().toLowerCase()}`);
  if (!u) throw new Error("no user with that e-mail address");
  if (u.deletedAt) throw new Error("that account has already been erased");

  if (command === "export") {
    const data = await exportMyData(db, u.id);
    const json = JSON.stringify(data, null, 2);
    if (values.out) { writeFileSync(values.out, json, { mode: 0o600 }); console.log(`written to ${values.out} (mode 600). Send it over a private channel and delete your copy.`); }
    else console.log(json);
  } else {
    if (!values.yes) throw new Error(`this permanently erases ${u.email}. Run again with --yes to confirm.`);
    const r = await eraseAccount(db, { id: u.id, email: u.email }, { abandonOrganizations: values.abandon });
    console.log(`erased ${u.email}: ${r.organizations} membership(s) wound down. Calendar events are removed by the background job.`);
    const check = await db.select({ email: users.email }).from(users).where(eq(users.id, u.id));
    console.log(`profile now reads ${check[0]?.email}`);
  }
} finally {
  await close();
}
