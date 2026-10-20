import { eq, isNull } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { organizations } from "@/db/schema";
import { DEFAULT_APP_NAME, appNameOrDefault } from "@/domain/app-name";
import { withWorker } from "@/jobs/context";

/**
 * The name the product goes by (src/domain/app-name.ts) as the pages and e-mails that have no organization to ask must find it:
 * this installation is meant to hold exactly one organization, and then the name is that organization's; with none or several there is no
 * single answer, so the default name is used. E-mails and pages that belong to an organization use that organization's own name (brandOf).
 */
export async function installationBrand(db: Db): Promise<string> {
  const now = Date.now();
  const remembered = read();
  if (remembered && now - remembered.at < CACHE_MS) return remembered.name;
  const rows = await withWorker(db, (tx) => tx.select({ appName: organizations.appName }).from(organizations).where(isNull(organizations.deletedAt)).limit(2));
  const name = rows.length === 1 ? appNameOrDefault(rows[0]!.appName) : DEFAULT_APP_NAME;
  memory().cache = { name, at: now };
  return name;
}

/** The organization's own name for the product, read inside a transaction that is already open for it. */
export async function brandOf(tx: Pick<Tx, "select">, orgId: string): Promise<string> {
  const [o] = await tx.select({ appName: organizations.appName }).from(organizations).where(eq(organizations.id, orgId));
  return appNameOrDefault(o?.appName);
}

// A page render asks for this on every request, so it is remembered for a few seconds. Changing the name clears it on the instance that
// handled the change; other instances (serverless) pick the change up within CACHE_MS. The memory lives on globalThis because a production
// build can load this file once for the page that renders the sign-in screen and once more for the route that saves the name; a plain
// module variable would then be cleared in one copy and keep the old name in the other.
const CACHE_MS = 10_000;
type Memory = { cache?: { name: string; at: number } };
const memory = (): Memory => ((globalThis as typeof globalThis & { __ttBrand?: Memory }).__ttBrand ??= {});
const read = () => memory().cache;
export const forgetBrand = () => { memory().cache = undefined; };
