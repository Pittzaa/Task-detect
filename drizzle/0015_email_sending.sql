ALTER TABLE "notifications" ADD COLUMN "email_wanted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "auto_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_email_waiting_idx" ON "notifications" USING btree ("org_id","created_at") WHERE "notifications"."email_wanted" and "notifications"."emailed_at" is null;