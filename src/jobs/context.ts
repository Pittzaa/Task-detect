import { sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";

/**
 * Background work has no signed-in user. It runs in a transaction flagged `app.worker = 'on'`, which the
 * RLS policies recognise for the few cross-organization reads the scheduler needs (jobs, pending outbox
 * events, the organization list). Everything else is done after switching to ONE organization, and the
 * org id always comes from a database row (a job or event), never from request input.
 */
export async function withWorker<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.worker', 'on', true), set_config('app.org_id', '', true), set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

export async function withWorkerOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.worker', 'on', true), set_config('app.org_id', ${orgId}, true), set_config('app.user_id', '', true)`);
    return fn(tx);
  });
}

/** Switches an open worker transaction to another organization. */
export async function switchOrg(tx: Tx, orgId: string) {
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
}
