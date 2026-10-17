CREATE TYPE "public"."custom_field_type" AS ENUM('text', 'number', 'date', 'dropdown', 'checkbox');--> statement-breakpoint
CREATE TYPE "public"."view_kind" AS ENUM('list', 'board', 'calendar', 'timeline', 'my_tasks');--> statement-breakpoint
CREATE TYPE "public"."view_scope" AS ENUM('personal', 'team', 'organization');--> statement-breakpoint
CREATE TABLE "custom_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "custom_field_type" NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_value" numeric,
	"max_value" numeric,
	"default_value" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_defs_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "custom_field_defs_name_len" CHECK (char_length("custom_field_defs"."name") between 1 and 60),
	CONSTRAINT "custom_field_defs_range" CHECK ("custom_field_defs"."min_value" is null or "custom_field_defs"."max_value" is null or "custom_field_defs"."max_value" >= "custom_field_defs"."min_value")
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"text_value" text,
	"number_value" numeric,
	"date_value" date,
	"option_value" text,
	"bool_value" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_values_task_id_field_id_pk" PRIMARY KEY("task_id","field_id"),
	CONSTRAINT "custom_field_values_single" CHECK ((case when "custom_field_values"."text_value" is not null then 1 else 0 end + case when "custom_field_values"."number_value" is not null then 1 else 0 end + case when "custom_field_values"."date_value" is not null then 1 else 0 end + case when "custom_field_values"."option_value" is not null then 1 else 0 end + case when "custom_field_values"."bool_value" is not null then 1 else 0 end) = 1)
);
--> statement-breakpoint
CREATE TABLE "recurrence_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"primary_assignee_id" uuid,
	"reminder_days_before" integer,
	"due_offset_days" integer DEFAULT 0 NOT NULL,
	"rule" jsonb NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"max_occurrences" integer,
	"timezone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"generated_through" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "recurrence_series_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "recurrence_series_title_len" CHECK (char_length("recurrence_series"."title") between 1 and 300),
	CONSTRAINT "recurrence_series_dates" CHECK ("recurrence_series"."end_date" is null or "recurrence_series"."end_date" >= "recurrence_series"."start_date"),
	CONSTRAINT "recurrence_series_offset" CHECK ("recurrence_series"."due_offset_days" between 0 and 365),
	CONSTRAINT "recurrence_series_max" CHECK ("recurrence_series"."max_occurrences" is null or "recurrence_series"."max_occurrences" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" "view_scope" DEFAULT 'personal' NOT NULL,
	"team_id" uuid,
	"kind" "view_kind" DEFAULT 'list' NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "saved_views_team_scope" CHECK (("saved_views"."scope" = 'team') = ("saved_views"."team_id" is not null)),
	CONSTRAINT "saved_views_name_len" CHECK (char_length("saved_views"."name") between 1 and 80)
);
--> statement-breakpoint
DROP INDEX "tasks_series_occurrence_uq";--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_task_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_field_fk" FOREIGN KEY ("org_id","field_id") REFERENCES "public"."custom_field_defs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_assignee_fk" FOREIGN KEY ("org_id","primary_assignee_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_defs_name_uq" ON "custom_field_defs" USING btree ("org_id",lower("name")) WHERE "custom_field_defs"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "custom_field_values_field_idx" ON "custom_field_values" USING btree ("org_id","field_id");--> statement-breakpoint
CREATE INDEX "saved_views_org_idx" ON "saved_views" USING btree ("org_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_series_occurrence_uq" ON "tasks" USING btree ("series_id","occurrence_date") WHERE "tasks"."series_id" is not null and "tasks"."deleted_at" is null;