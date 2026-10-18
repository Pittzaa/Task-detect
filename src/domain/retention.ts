/**
 * Retention policy (documented in docs/RETENTION.md). One place so the purge job, the tests and the docs agree.
 * Day counts are *minimums*: data is kept at least this long; the daily job removes it afterwards.
 */
export const RETENTION = {
  /** Required by the product spec. The database function purge_audit_logs() enforces this as a floor. */
  auditLogDays: 90,
  /** Soft-deleted tasks (with subtasks, comments, attachments, history) stay restorable this long. */
  trashDays: 30,
  /** A removed attachment's file is kept this long so an accidental delete can be undone by an administrator. */
  attachmentTrashDays: 30,
  /** Soft-deleted saved views. */
  viewTrashDays: 30,
  /** Individually deleted comments (their text is removed for good after this). */
  commentTrashDays: 30,
  /** Deleted Discord destinations (the webhook secret itself is destroyed at deletion time). */
  destinationTrashDays: 30,
  finishedJobDays: 7,
  /** Dead-lettered jobs are kept longer so an operator can investigate them. */
  deadJobDays: 30,
  processedOutboxDays: 7,
  /** In-app notifications. */
  notificationDays: 90,
  deliveryAttemptDays: 30,
  digestLogDays: 35,
  /** Expired sessions / verification tokens / OAuth states are removed this long after they expire. */
  expiredAuthGraceDays: 1,
  /** An object in storage with no database row is only deleted after this long (an upload may still be committing). */
  orphanGraceHours: 24,
} as const;

export const DAY_MS = 86_400_000;

export const cutoffDays = (now: Date, days: number): Date => new Date(now.getTime() - days * DAY_MS);
export const cutoffHours = (now: Date, hours: number): Date => new Date(now.getTime() - hours * 3_600_000);

/** Batch sizes keep every purge transaction short; the job loops until it runs out of work or time. */
export const PURGE_BATCH = 100;
