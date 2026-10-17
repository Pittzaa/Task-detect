import { randomBytes } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { outboxEvents } from "@/db/schema";
import { createCaptureSender } from "@/integrations/email";
import type { ObjectStore } from "@/integrations/storage";
import { createFsStore } from "@/integrations/storage/fs";
import { outboxProcess } from "@/jobs/handlers/outbox";
import { registry } from "@/jobs/registry";
import { runWorker, type JobContext } from "@/jobs/worker";
import type { JobRow } from "@/jobs/queue";

export const KEY = randomBytes(32).toString("base64");

export interface Clock { now: Date }

/** Follows real time until a test assigns `clock.now`, which freezes it at that instant. */
export function liveClock(): Clock {
  let fixed: Date | null = null;
  return {
    get now() { return fixed ?? new Date(); },
    set now(v: Date) { fixed = v; },
  };
}

export function makeJobCtx(db: Db, o: { clock?: Clock; store?: ObjectStore; email?: ReturnType<typeof createCaptureSender>; fetchImpl?: typeof fetch; google?: JobContext["google"] } = {}) {
  const clock = o.clock ?? liveClock();
  const email = o.email ?? createCaptureSender();
  const ctx: JobContext = { db, email, store: o.store ?? createFsStore(".data/test-uploads"), appUrl: "http://localhost:3000", encryptionKeys: [KEY], fetchImpl: o.fetchImpl ?? fetch, google: o.google, now: () => clock.now };
  return { ctx, clock, email };
}

/** Runs the outbox processor, then drains every job that is due (email, Discord, calendar, ...). */
export async function pump(ctx: JobContext, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await outboxProcess(ctx, {} as JobRow);
    await runWorker(ctx, registry, { maxMs: 4000, batch: 20 });
  }
}

/** Marks every pending outbox event processed so a test starts from a clean slate. */
export async function clearOutbox(admin: Db) {
  await admin.update(outboxEvents).set({ processedAt: new Date() }).where(isNull(outboxEvents.processedAt));
}

export const resetEvent = (admin: Db, id: string) => admin.update(outboxEvents).set({ processedAt: null, attempts: 0 }).where(eq(outboxEvents.id, id));
