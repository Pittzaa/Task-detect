/**
 * Number of migrations this build expects to be applied (drizzle/meta/_journal.json). The readiness endpoint compares
 * it with the database, so a deployment that went out before `pnpm db:migrate` is reported instead of failing on first
 * use. A unit test keeps this number equal to the journal.
 */
export const EXPECTED_MIGRATIONS = 15;

/**
 * How the readiness check judges the database. A database BEHIND this build is a failure (the code would meet tables or columns that
 * are not there yet). A database AHEAD of it is what an instant rollback to the previous build looks like (migrations only add), so it
 * is reported but not treated as down.
 */
export function migrationsStatus(applied: number, expected = EXPECTED_MIGRATIONS): { ok: boolean; detail: string | number } {
  if (applied === expected) return { ok: true, detail: applied };
  if (applied > expected) return { ok: true, detail: `database has ${applied}, this build expects ${expected} (database is ahead of this build)` };
  return { ok: false, detail: `database has ${applied}, build expects ${expected}` };
}
