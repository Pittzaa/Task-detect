import { parseArgs } from "node:util";
import { bootstrapOrganization, setPlatformAdmin } from "../src/data/bootstrap";
import { createDb } from "../src/db/client";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    slug: { type: "string" },
    "admin-email": { type: "string" },
    "app-url": { type: "string" },
    superadmin: { type: "string" },
    "allow-additional": { type: "boolean" },
  },
});

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required");
const { db, close } = createDb(url);

try {
  if (values.superadmin) {
    await setPlatformAdmin(db, values.superadmin);
    console.log(`platform admin flag set for ${values.superadmin}`);
  } else {
    if (!values.name || !values.slug || !values["admin-email"]) {
      throw new Error("usage: pnpm bootstrap --name <org name> --slug <code> --admin-email <email> [--app-url <url>] [--allow-additional]");
    }
    const r = await bootstrapOrganization(db, {
      name: values.name, slug: values.slug, adminEmail: values["admin-email"], appUrl: values["app-url"] ?? process.env.APP_URL ?? "http://localhost:3000",
      allowAdditional: values["allow-additional"],
    });
    console.log(`organization ${r.orgId} ready.\nSend this one-time link to ${values["admin-email"]} (valid 7 days):\n${r.inviteUrl}`);
  }
} finally {
  await close();
}
