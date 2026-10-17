CREATE TYPE "public"."delivery_status" AS ENUM('sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."digest_frequency" AS ENUM('off', 'daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'email');--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_ciphertext" text NOT NULL,
	"scope" text NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "calendar_connections_status" CHECK ("calendar_connections"."status" in ('active','revoked','error','disconnecting'))
);
--> statement-breakpoint
CREATE TABLE "calendar_event_links" (
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"google_event_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "calendar_event_links_connection_id_task_id_pk" PRIMARY KEY("connection_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" "delivery_status" NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_log" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_log_org_id_user_id_period_key_pk" PRIMARY KEY("org_id","user_id","period_key")
);
--> statement-breakpoint
CREATE TABLE "integration_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"name" text NOT NULL,
	"webhook_ciphertext" text NOT NULL,
	"webhook_hint" text NOT NULL,
	"events" text[] NOT NULL,
	"include_details" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_status" text,
	"last_delivery_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "integration_destinations_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "integration_destinations_one_target" CHECK (("integration_destinations"."team_id" is not null) <> ("integration_destinations"."project_id" is not null)),
	CONSTRAINT "integration_destinations_name_len" CHECK (char_length("integration_destinations"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"digest" "digest_frequency" DEFAULT 'off' NOT NULL,
	"quiet_start" text,
	"quiet_end" text,
	CONSTRAINT "notification_prefs_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "notification_prefs_quiet_pair" CHECK (("notification_prefs"."quiet_start" is null) = ("notification_prefs"."quiet_end" is null)),
	CONSTRAINT "notification_prefs_quiet_fmt" CHECK ("notification_prefs"."quiet_start" is null or ("notification_prefs"."quiet_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "notification_prefs"."quiet_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"event" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "notification_settings_org_id_user_id_channel_event_pk" PRIMARY KEY("org_id","user_id","channel","event")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"task_id" uuid,
	"actor_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"digested_at" timestamp with time zone,
	CONSTRAINT "notifications_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"code_verifier_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_connection_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."calendar_connections"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_task_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_destinations" ADD CONSTRAINT "integration_destinations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_destinations" ADD CONSTRAINT "integration_destinations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_destinations" ADD CONSTRAINT "integration_destinations_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_destinations" ADD CONSTRAINT "integration_destinations_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_user_uq" ON "calendar_connections" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "calendar_event_links_task_idx" ON "calendar_event_links" USING btree ("org_id","task_id");--> statement-breakpoint
CREATE INDEX "delivery_attempts_subject_idx" ON "delivery_attempts" USING btree ("org_id","subject_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" in ('pending','running');--> statement-breakpoint
CREATE INDEX "jobs_org_status_idx" ON "jobs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("org_id","user_id","created_at");