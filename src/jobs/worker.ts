import { randomUUID } from "node:crypto";
import type { Db } from "@/db/client";
import type { EmailSender } from "@/integrations/email";
import type { ObjectStore } from "@/integrations/storage";
import { logger } from "@/lib/logger";
import { claimJobs, completeJob, deferJob, failJob, type JobRow } from "./queue";

/** Thrown by a handler to say "not now": the try is not counted as a failure. */
export class Deferred extends Error {
  constructor(readonly runAt: Date, readonly reason: string) {
    super(reason);
  }
}

/** Thrown by a handler when retrying cannot help (bad configuration, revoked access, malformed job). */
export class PermanentFailure extends Error {
  constructor(readonly errorClass: string) {
    super(errorClass);
  }
}

export interface JobContext {
  db: Db;
  email: EmailSender;
  /** Private attachment storage (retention and orphan cleanup delete objects). */
  store: ObjectStore;
  appUrl: string;
  /** Secrets for at-rest encryption, current first. */
  encryptionKeys: string[];
  /** Overridable for integrations in tests; defaults to global fetch. */
  fetchImpl: typeof fetch;
  google?: { clientId: string; clientSecret: string; tokenUrl?: string; apiBase?: string; redirectUri: string };
  now: () => Date;
  /** Epoch ms by which the run that is calling the handler wants to be finished (set by runWorker). Long handlers stop early at it. */
  deadline?: number;
}

export type JobHandler = (ctx: JobContext, job: JobRow) => Promise<void>;
export type Registry = Record<string, JobHandler>;

/** Error class safe to persist: the constructor name and an optional numeric status, never the message. */
export function errorClassOf(e: unknown): string {
  if (e instanceof Error) {
    const status = (e as { status?: number }).status;
    return `${e.constructor.name}${status ? `:${status}` : ""}`;
  }
  return "UnknownError";
}

export interface RunStats {
  processed: number;
  succeeded: number;
  retried: number;
  dead: number;
  deferred: number;
}

export async function runWorker(ctx: JobContext, registry: Registry, o: { maxMs?: number; batch?: number; leaseSeconds?: number; jobTimeoutMs?: number; workerId?: string } = {}): Promise<RunStats> {
  const workerId = o.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + (o.maxMs ?? 50_000);
  const stats: RunStats = { processed: 0, succeeded: 0, retried: 0, dead: 0, deferred: 0 };
  const leaseSeconds = o.leaseSeconds ?? 120;
  const jobTimeoutMs = o.jobTimeoutMs ?? 60_000;

  while (Date.now() < deadline) {
    const batch = await claimJobs(ctx.db, { limit: o.batch ?? 10, leaseSeconds, workerId, now: ctx.now(), kinds: Object.keys(registry) });
    if (!batch.length) break;
    for (const job of batch) {
      stats.processed++;
      const handler = registry[job.kind];
      try {
        if (!handler) throw new PermanentFailure("UnknownJobKind"); // unreachable: only registry kinds are claimed
        await withTimeout(handler({ ...ctx, deadline }, job), jobTimeoutMs);
        await completeJob(ctx.db, job, ctx.now());
        stats.succeeded++;
      } catch (e) {
        if (e instanceof Deferred) {
          await deferJob(ctx.db, job, e.runAt, e.reason, ctx.now());
          stats.deferred++;
        } else {
          const permanent = e instanceof PermanentFailure;
          const outcome = await failJob(ctx.db, job, e instanceof PermanentFailure ? e.errorClass : errorClassOf(e), { permanent, now: ctx.now() });
          if (outcome === "dead") stats.dead++;
          else stats.retried++;
          logger.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, outcome, errorClass: errorClassOf(e) }, "job failed");
        }
      }
    }
  }
  return stats;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("JobTimeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
