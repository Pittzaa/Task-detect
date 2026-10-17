-- Worker context: background jobs run with app.worker = 'on' and then switch to one organization at a time.
-- The setting is only ever set by src/jobs/context.ts; it is not derived from any request input.
CREATE FUNCTION app_is_worker() RETURNS boolean LANGUAGE sql STABLE AS
$$ select coalesce(current_setting('app.worker', true), '') = 'on' $$;
--> statement-breakpoint
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notifications USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_settings USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_prefs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_prefs USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE delivery_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE delivery_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON delivery_attempts USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE digest_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE digest_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON digest_log USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE integration_destinations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integration_destinations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON integration_destinations USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendar_connections USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE calendar_event_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_event_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendar_event_links USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tenant sessions can enqueue and see their own org's jobs; global jobs (org_id NULL) are worker-only.
CREATE POLICY jobs_access ON jobs USING (org_id = app_org_id() OR app_is_worker()) WITH CHECK (org_id = app_org_id() OR app_is_worker());
--> statement-breakpoint
-- The worker must scan pending events and list organizations before it can pick an org context.
CREATE POLICY outbox_worker ON outbox_events USING (app_is_worker()) WITH CHECK (app_is_worker());
--> statement-breakpoint
CREATE POLICY org_worker_select ON organizations FOR SELECT USING (app_is_worker());
--> statement-breakpoint
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY oauth_states_owner ON oauth_states USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
