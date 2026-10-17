-- Row-level security for Phase 3 tables, and the link from occurrences back to their series.
ALTER TABLE recurrence_series ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recurrence_series FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON recurrence_series USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE custom_field_defs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE custom_field_defs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON custom_field_defs USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE custom_field_values ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE custom_field_values FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON custom_field_values USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON saved_views USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT tasks_series_fk FOREIGN KEY (org_id, series_id) REFERENCES recurrence_series (org_id, id);
