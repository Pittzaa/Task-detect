import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { Pool as NeonPool } from "@neondatabase/serverless";
import pg from "pg";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Interactive transactions are required (tenant context is set per transaction), so Neon traffic
 * uses the WebSocket Pool driver rather than the HTTP driver. Any other host (local/test Postgres)
 * uses node-postgres.
 */
export function createDb(connectionString: string): { db: Db; close: () => Promise<void> } {
  if (/\.neon\.tech/.test(connectionString)) {
    const pool = new NeonPool({ connectionString });
    return { db: drizzleNeon({ client: pool, schema }) as unknown as Db, close: () => pool.end() };
  }
  const pool = new pg.Pool({ connectionString });
  return { db: drizzlePg({ client: pool, schema }) as unknown as Db, close: () => pool.end() };
}

/**
 * Row-level security is only a safety net when the runtime role cannot bypass it. Call at
 * startup in production and refuse to serve traffic if this returns a problem.
 */
export async function checkRlsEnforceable(db: Db): Promise<string | null> {
  const res = (await db.execute(
    sql`select rolsuper, rolbypassrls,
          coalesce((select pg_has_role(current_user, c.relowner, 'USAGE') from pg_class c where c.oid = 'public.organizations'::regclass), false) as owns
        from pg_roles where rolname = current_user`,
  )) as unknown as { rows: { rolsuper: boolean; rolbypassrls: boolean; owns: boolean }[] };
  const row = res.rows[0];
  if (!row) return "current database role not found";
  if (row.rolsuper) return "runtime role is a superuser; RLS is bypassed";
  if (row.rolbypassrls) return "runtime role has BYPASSRLS; RLS is bypassed";
  // Some policies are written for the owner only (creating organizations, system roles, the audit purge). A runtime role that is,
  // or inherits, the owner would get those powers: the application must connect as a separate least-privilege role (scripts/grants.sql).
  if (row.owns) return "runtime role owns the tables (or belongs to the role that does); owner-only policies would apply to it";
  return null;
}
