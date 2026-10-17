CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'progress', 'review', 'done', 'cancelled', 'blocked');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "attachments_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "attachments_size" CHECK ("attachments"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "comment_mentions" (
	"org_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "comment_mentions_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "comments_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "comments_body_len" CHECK (char_length("comments"."body") between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "labels_color_hex" CHECK ("labels"."color" ~ '^#[0-9a-fA-F]{6}$')
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_assignees" (
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_assignees_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_id_pk" PRIMARY KEY("task_id","depends_on_id"),
	CONSTRAINT "task_dependencies_not_self" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_id")
);
--> statement-breakpoint
CREATE TABLE "task_labels" (
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "task_labels_task_id_label_id_pk" PRIMARY KEY("task_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"series_id" uuid,
	"occurrence_date" date,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"start_date" date,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"reminder_days_before" integer,
	"primary_assignee_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "tasks_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "tasks_title_len" CHECK (char_length("tasks"."title") between 1 and 300),
	CONSTRAINT "tasks_description_len" CHECK (char_length("tasks"."description") <= 20000),
	CONSTRAINT "tasks_date_range" CHECK ("tasks"."start_date" is null or "tasks"."due_date" is null or "tasks"."due_date" >= "tasks"."start_date"),
	CONSTRAINT "tasks_not_own_parent" CHECK ("tasks"."parent_id" is null or "tasks"."parent_id" <> "tasks"."id"),
	CONSTRAINT "tasks_completed_iff_done" CHECK (("tasks"."status" = 'done') = ("tasks"."completed_at" is not null)),
	CONSTRAINT "tasks_reminder_range" CHECK ("tasks"."reminder_days_before" is null or "tasks"."reminder_days_before" between 0 and 30)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_fk" FOREIGN KEY ("org_id","comment_id") REFERENCES "public"."comments"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_task_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_task_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_prereq_fk" FOREIGN KEY ("org_id","depends_on_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_task_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_label_fk" FOREIGN KEY ("org_id","label_id") REFERENCES "public"."labels"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "public"."tasks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_fk" FOREIGN KEY ("org_id","primary_assignee_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_task_idx" ON "attachments" USING btree ("org_id","task_id");--> statement-breakpoint
CREATE INDEX "comments_task_idx" ON "comments" USING btree ("org_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_org_name_uq" ON "labels" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "task_activity_task_idx" ON "task_activity" USING btree ("org_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_assignees_user_idx" ON "task_assignees" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_prereq_idx" ON "task_dependencies" USING btree ("org_id","depends_on_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_series_occurrence_uq" ON "tasks" USING btree ("series_id","occurrence_date") WHERE "tasks"."series_id" is not null;--> statement-breakpoint
CREATE INDEX "tasks_project_status_idx" ON "tasks" USING btree ("org_id","project_id","status") WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("org_id","primary_assignee_id","status") WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("org_id","due_date") WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("org_id","parent_id");