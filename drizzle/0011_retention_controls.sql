-- Retention controls (docs/RETENTION.md).
--
-- 1. Audit logs are append-only for the application role: it has no UPDATE/DELETE grant and no DELETE policy. The
--    only way to remove audit rows is this function, which runs as the table owner and can NEVER delete anything
--    younger than 90 days, whatever argument it is given. A compromised application can therefore not erase recent
--    history, and the 90-day policy is enforced by the database rather than by application code.
CREATE FUNCTION purge_audit_logs(p_days integer DEFAULT 90) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE removed bigint;
BEGIN
  DELETE FROM audit_logs WHERE created_at < now() - make_interval(days => greatest(coalesce(p_days, 90), 90));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_audit_logs(integer) FROM PUBLIC;
--> statement-breakpoint
-- The function runs as the owner. FORCE ROW LEVEL SECURITY applies to the owner too (unless it has BYPASSRLS, which
-- managed providers may grant), so give the owner exactly one narrow permission: deleting rows older than 90 days.
-- A DELETE with a WHERE clause must also be allowed to SEE the rows, hence the matching SELECT policy.
CREATE POLICY audit_retention_select ON audit_logs FOR SELECT TO CURRENT_USER USING (created_at < now() - interval '90 days');
--> statement-breakpoint
CREATE POLICY audit_retention ON audit_logs FOR DELETE TO CURRENT_USER USING (created_at < now() - interval '90 days');
--> statement-breakpoint
-- 2. task_activity is append-only for tenant sessions. When a task is permanently purged its history goes with it, but
--    only in worker context, only inside one organization, and only for tasks that are already in the trash.
CREATE POLICY activity_purge ON task_activity FOR DELETE USING (
  app_is_worker() AND org_id = app_org_id()
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.org_id = task_activity.org_id AND t.id = task_activity.task_id AND t.deleted_at IS NOT NULL)
);
--> statement-breakpoint
-- 3. Expired OAuth states are removed by the scheduler, which has no user context. A DELETE with a WHERE clause also
--    needs the rows to be visible through a SELECT policy, so both are granted, both limited to expired rows.
CREATE POLICY oauth_states_purge_select ON oauth_states FOR SELECT USING (app_is_worker() AND expires_at < now());
--> statement-breakpoint
CREATE POLICY oauth_states_purge ON oauth_states FOR DELETE USING (app_is_worker() AND expires_at < now());
