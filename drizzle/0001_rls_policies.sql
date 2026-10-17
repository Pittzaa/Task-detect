-- Row-level security: defense in depth behind the explicit org_id filters in application code.
-- Context is set per transaction by src/data/tenant.ts:
--   select set_config('app.user_id', ..., true), set_config('app.org_id', ..., true)
-- A missing/empty setting yields NULL, which matches no rows (deny by default).
-- Policies only bind roles WITHOUT BYPASSRLS/superuser; see docs/SECURITY.md and checkRlsEnforceable().

CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ select nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- Plain org-scoped tables: every command limited to the current org.
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON departments USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON teams USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON projects USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE project_teams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_teams FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON project_teams USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE role_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON role_assignments USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint

-- organizations: a session can read only its current organization. Creating/deleting orgs is an admin path.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_select ON organizations FOR SELECT USING (id = app_org_id());
--> statement-breakpoint

-- memberships: a user may see their own memberships in any org (needed to resolve access before an
-- org context exists) but may only write rows of the current org.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY membership_select ON memberships FOR SELECT USING (org_id = app_org_id() OR user_id = app_user_id());
--> statement-breakpoint
CREATE POLICY membership_insert ON memberships FOR INSERT WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY membership_update ON memberships FOR UPDATE USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY membership_delete ON memberships FOR DELETE USING (org_id = app_org_id());
--> statement-breakpoint

-- roles: system roles (org_id NULL) are readable by everyone, writable by no tenant session.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY roles_select ON roles FOR SELECT USING (org_id IS NULL OR org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY roles_insert ON roles FOR INSERT WITH CHECK (org_id = app_org_id() AND NOT is_system);
--> statement-breakpoint
CREATE POLICY roles_update ON roles FOR UPDATE USING (org_id = app_org_id() AND NOT is_system) WITH CHECK (org_id = app_org_id() AND NOT is_system);
--> statement-breakpoint
CREATE POLICY roles_delete ON roles FOR DELETE USING (org_id = app_org_id() AND NOT is_system);
--> statement-breakpoint

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rp_select ON role_permissions FOR SELECT
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id));
--> statement-breakpoint
CREATE POLICY rp_write_insert ON role_permissions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.org_id = app_org_id() AND NOT r.is_system));
--> statement-breakpoint
CREATE POLICY rp_write_delete ON role_permissions FOR DELETE
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.org_id = app_org_id() AND NOT r.is_system));
--> statement-breakpoint

-- audit_logs: append-only for tenant sessions (no UPDATE/DELETE policy, and grants revoke them too).
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_select ON audit_logs FOR SELECT USING (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (org_id = app_org_id());
