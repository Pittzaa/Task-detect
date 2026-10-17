import { readFileSync } from "node:fs";
import pg from "pg";
import { runMigrations } from "../../scripts/migrate";
import { createDb } from "../../src/db/client";
import { syncSystemRoles } from "../../src/data/system-roles";

export const APP_ROLE = "tt_app_test";

/**
 * Builds a fresh schema on an isolated TEST database as superuser, then creates a
 * least-privilege runtime role so the tests exercise RLS the way production would.
 * Refuses to run against anything that is not clearly a test database.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL (superuser connection to an isolated test database) is required");
  const dbName = new URL(url).pathname.slice(1);
  if (!/test/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}": name must contain "test"`);

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query("drop schema if exists public cascade");
    await admin.query("drop schema if exists drizzle cascade");
    await admin.query("create schema public");
    await admin.query(`drop owned by ${APP_ROLE}`).catch(() => undefined);
    await admin.query(`drop role if exists ${APP_ROLE}`);
  } finally {
    await admin.end();
  }

  await runMigrations(url);

  const admin2 = new pg.Client({ connectionString: url });
  await admin2.connect();
  try {
    await admin2.query(`create role ${APP_ROLE} login password 'app' nosuperuser nobypassrls`);
    await admin2.query(readFileSync("scripts/grants.sql", "utf8").replaceAll("{{APP_ROLE}}", APP_ROLE));
  } finally {
    await admin2.end();
  }

  const { db, close } = createDb(url);
  try {
    await syncSystemRoles(db);
  } finally {
    await close();
  }
}
