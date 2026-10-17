import { and, eq, isNull } from "drizzle-orm";
import { generateForSeriesAsCreator } from "@/data/series";
import { organizations, recurrenceSeries } from "@/db/schema";
import { logger } from "@/lib/logger";
import { withWorker, withWorkerOrg } from "../context";
import type { JobHandler } from "../worker";

/** Tops up recurring-task occurrences for every active series. Idempotent: see generateOccurrences. */
export const seriesGenerate: JobHandler = async (ctx) => {
  const orgs = await withWorker(ctx.db, (tx) => tx.select({ id: organizations.id }).from(organizations).where(isNull(organizations.deletedAt)));
  for (const org of orgs) {
    const series = await withWorkerOrg(ctx.db, org.id, (tx) => tx.select({ id: recurrenceSeries.id }).from(recurrenceSeries).where(and(eq(recurrenceSeries.orgId, org.id), eq(recurrenceSeries.active, true), isNull(recurrenceSeries.deletedAt))));
    for (const s of series) {
      try {
        await generateForSeriesAsCreator(ctx.db, org.id, s.id);
      } catch (e) {
        logger.error({ orgId: org.id, seriesId: s.id, err: e instanceof Error ? e.constructor.name : "unknown" }, "series generation failed");
      }
    }
  }
};
