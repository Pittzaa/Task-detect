CREATE INDEX "attachments_trash_idx" ON "attachments" USING btree ("deleted_at") WHERE "attachments"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "delivery_attempts_created_idx" ON "delivery_attempts" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_finished_idx" ON "jobs" USING btree ("finished_at") WHERE "jobs"."status" in ('succeeded','dead');--> statement-breakpoint
CREATE INDEX "notifications_org_created_idx" ON "notifications" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_processed_idx" ON "outbox_events" USING btree ("processed_at") WHERE "outbox_events"."processed_at" is not null;--> statement-breakpoint
CREATE INDEX "tasks_trash_idx" ON "tasks" USING btree ("deleted_at") WHERE "tasks"."deleted_at" is not null;