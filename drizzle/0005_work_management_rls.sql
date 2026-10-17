-- Row-level security, integrity triggers and search index for work-management tables.
ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE labels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON labels USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tasks USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE task_assignees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE task_assignees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON task_assignees USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE task_dependencies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON task_dependencies USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE task_labels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE task_labels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON task_labels USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON comments USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE comment_mentions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE comment_mentions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON comment_mentions USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON attachments USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbox_events USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint

-- task_activity is append-only for tenant sessions.
ALTER TABLE task_activity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE task_activity FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY activity_select ON task_activity FOR SELECT USING (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY activity_insert ON task_activity FOR INSERT WITH CHECK (org_id = app_org_id());
--> statement-breakpoint

-- A subtask must live in the same project as its parent.
CREATE FUNCTION tasks_check_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_project uuid;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT project_id INTO parent_project FROM tasks WHERE org_id = NEW.org_id AND id = NEW.parent_id;
    IF parent_project IS NULL OR parent_project <> NEW.project_id THEN
      RAISE EXCEPTION 'subtask must belong to the same project as its parent' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_parent_project BEFORE INSERT OR UPDATE OF parent_id, project_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_check_parent();
--> statement-breakpoint

-- Refuse a task hierarchy cycle (a task may not become its own ancestor). Serialised per org so two
-- concurrent re-parenting transactions cannot jointly create a cycle.
CREATE FUNCTION tasks_check_parent_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('task-tree:' || NEW.org_id::text, 0));
    IF EXISTS (
      WITH RECURSIVE ancestors(id) AS (
        SELECT NEW.parent_id
        UNION
        SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id = a.id AND t.org_id = NEW.org_id WHERE t.parent_id IS NOT NULL
      )
      SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
      RAISE EXCEPTION 'task hierarchy cycle' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_parent_cycle BEFORE INSERT OR UPDATE OF parent_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_check_parent_cycle();
--> statement-breakpoint

-- Refuse a dependency cycle: the new edge (task depends on prerequisite) must not make the task a
-- (transitive) prerequisite of itself. Serialised per org for the same reason as above.
CREATE FUNCTION task_dependencies_check_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('task-deps:' || NEW.org_id::text, 0));
  IF EXISTS (
    WITH RECURSIVE upstream(id) AS (
      SELECT NEW.depends_on_id
      UNION
      SELECT d.depends_on_id FROM task_dependencies d JOIN upstream u ON d.task_id = u.id AND d.org_id = NEW.org_id
    )
    SELECT 1 FROM upstream WHERE id = NEW.task_id
  ) THEN
    RAISE EXCEPTION 'dependency cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_dependencies_cycle BEFORE INSERT OR UPDATE ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION task_dependencies_check_cycle();
--> statement-breakpoint

-- Substring search that also works for Thai (no word boundaries).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX tasks_title_trgm_idx ON tasks USING gin (lower(title) gin_trgm_ops) WHERE deleted_at IS NULL;
