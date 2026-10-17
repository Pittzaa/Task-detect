import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { bootstrapOrganization } from "../src/data/bootstrap";
import { createDb } from "../src/db/client";
import { runMigrations } from "./migrate";

/**
 * Builds a fresh, isolated database for browser tests: schema, least-privilege runtime role, system roles and two
 * organizations (each with a one-time admin invitation). Refuses to touch any database not named "*e2e*".
 */
export const E2E_DB = "tasktracker_e2e";
export const E2E_ROLE = "tt_app_e2e";
export const STATE_DIR = ".data/e2e";

export async function setupE2e(adminBase = process.env.E2E_DB_ADMIN_URL ?? "postgres://postgres@127.0.0.1:54329/postgres") {
  const root = new pg.Client({ connectionString: adminBase });
  await root.connect();
  try {
    await root.query(`drop database if exists ${E2E_DB} with (force)`);
    await root.query(`create database ${E2E_DB}`);
  } finally { await root.end(); }

  const dbUrl = new URL(adminBase);
  dbUrl.pathname = `/${E2E_DB}`;
  const adminUrl = dbUrl.toString();
  if (!/e2e/.test(new URL(adminUrl).pathname)) throw new Error("refusing to set up a non-e2e database");
  await runMigrations(adminUrl);

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`drop owned by ${E2E_ROLE}`).catch(() => undefined);
    await admin.query(`drop role if exists ${E2E_ROLE}`);
    await admin.query(`create role ${E2E_ROLE} login password 'app' nosuperuser nobypassrls`);
    await admin.query(readFileSync("scripts/grants.sql", "utf8").replaceAll("{{APP_ROLE}}", E2E_ROLE));
  } finally { await admin.end(); }

  const appUrl = new URL(adminUrl);
  appUrl.username = E2E_ROLE; appUrl.password = "app";

  const { db, close } = createDb(adminUrl);
  try {
    const acme = await bootstrapOrganization(db, { name: "Acme Co", slug: "acme", adminEmail: "admin@e2e.test", appUrl: "http://localhost:3100" });
    const globex = await bootstrapOrganization(db, { name: "Globex", slug: "globex", adminEmail: "boss@e2e.test", appUrl: "http://localhost:3100" });
    rmSync(STATE_DIR, { recursive: true, force: true });
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(`${STATE_DIR}/state.json`, JSON.stringify({ acme, globex, databaseUrl: appUrl.toString() }));
    writeFileSync(`${STATE_DIR}/emails.jsonl`, "");
    return { acme, globex, databaseUrl: appUrl.toString() };
  } finally { await close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setupE2e().then((r) => console.log("e2e database ready", r.acme.orgId), (e) => { console.error(e); process.exit(1); });
}
