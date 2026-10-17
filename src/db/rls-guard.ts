import { unavailable } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRlsEnforceable, type Db } from "./client";

/**
 * Row-level security protects tenants only if the runtime role cannot bypass it. In production-like tiers the runtime
 * turns this guard on, and every tenant or worker transaction first confirms (once per hour per process, or every 30 s
 * while failing) that the connected role is neither a superuser nor BYPASSRLS. If it is, the request is refused with
 * 503 rather than served without the database-level safety net.
 */
let enabled = false;
const verdicts = new WeakMap<Db, { at: number; problem: string | null }>();

export function enableRlsGuard(on: boolean) {
  enabled = on;
}

export async function assertRlsEnforced(db: Db): Promise<void> {
  if (!enabled) return;
  const known = verdicts.get(db);
  const ttl = known?.problem ? 30_000 : 3_600_000;
  if (known && Date.now() - known.at < ttl) {
    if (known.problem) throw unavailable();
    return;
  }
  let problem: string | null;
  try {
    problem = await checkRlsEnforceable(db);
  } catch {
    problem = "could not verify the database role";
  }
  verdicts.set(db, { at: Date.now(), problem });
  if (problem) {
    logger.fatal({ problem }, "refusing to serve: the database role does not enforce row-level security");
    throw unavailable();
  }
}
