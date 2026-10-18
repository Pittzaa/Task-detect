import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";
import { exportOrganization, importOrganization, openBundle, sealBundle } from "../src/ops/org-transfer";

/**
 * Per-organization export / import (partial restore). Needs an OPERATOR connection (superuser or BYPASSRLS — the role used for pg_dump).
 *   pnpm org export --org <code|uuid> --out acme.org.gz
 *   pnpm org import --file acme.org.gz                  # dry run: prints what would happen
 *   pnpm org import --file acme.org.gz --apply          # new organization (or empty target)
 *   pnpm org import --file acme.org.gz --apply --replace   # overwrite the existing organization: everything newer than the bundle is LOST
 * Set ORG_EXPORT_PASSPHRASE (>= 12 characters) to encrypt on export / decrypt on import. See docs/BACKUP_RESTORE.md §7.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { org: { type: "string" }, out: { type: "string" }, file: { type: "string" }, apply: { type: "boolean" }, replace: { type: "boolean" } },
});
const [command] = positionals;
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required: an operator role (BYPASSRLS or superuser)");
const passphrase = process.env.ORG_EXPORT_PASSPHRASE || undefined;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (command === "export") {
    if (!values.org || !values.out) throw new Error("usage: pnpm org export --org <code|uuid> --out <file>");
    const bundle = await exportOrganization(client, values.org);
    writeFileSync(values.out, sealBundle(bundle, passphrase), { mode: 0o600 });
    console.log(`exported "${bundle.org.slug}" (${bundle.org.id}) to ${values.out}${passphrase ? " (encrypted)" : " (NOT encrypted: contains all of the organization's data; set ORG_EXPORT_PASSPHRASE)"}`);
    console.log(Object.entries(bundle.counts).filter(([, n]) => n > 0).map(([t, n]) => `  ${t}: ${n}`).join("\n"));
    console.log("Attachment FILES are not in the bundle; back them up with `pnpm backup:attachments` (docs/BACKUP_RESTORE.md).");
  } else if (command === "import") {
    if (!values.file) throw new Error("usage: pnpm org import --file <file> [--apply] [--replace]");
    const bundle = openBundle(readFileSync(values.file), passphrase);
    const plan = await importOrganization(client, bundle, { apply: values.apply, replace: values.replace });
    console.log(`${plan.applied ? "IMPORTED" : "DRY RUN (nothing changed; add --apply)"}: "${plan.org.slug}" (${plan.org.id}); organization ${plan.exists ? (plan.applied ? "existed and was REPLACED" : "exists, would be REPLACED") : (plan.applied ? "was created" : "is new here")}`);
    console.log(`users to create: ${plan.usersToCreate} (without credentials: they use "forgot password"), already present: ${plan.usersAlreadyPresent}`);
    for (const [t, n] of Object.entries(plan.incomingRows)) {
      if (n > 0 || plan.existingRows[t]) console.log(`  ${t.padEnd(24)} incoming ${String(n).padStart(6)}${plan.exists ? `   now in database ${String(plan.existingRows[t] ?? 0).padStart(6)}` : ""}`);
    }
  } else {
    throw new Error("usage: pnpm org <export|import> …");
  }
} finally {
  await client.end();
}
