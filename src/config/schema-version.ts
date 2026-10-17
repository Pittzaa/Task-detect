/**
 * Number of migrations this build expects to be applied (drizzle/meta/_journal.json). The readiness endpoint compares
 * it with the database, so a deployment that went out before `pnpm db:migrate` is reported instead of failing on first
 * use. A unit test keeps this number equal to the journal.
 */
export const EXPECTED_MIGRATIONS = 12;
