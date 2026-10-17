-- Operator bootstrap (scripts/bootstrap.ts, syncSystemRoles) must work for a plain database owner, i.e. one WITHOUT
-- BYPASSRLS, because FORCE ROW LEVEL SECURITY applies to the owner too. These policies are bound to the role that ran
-- the migrations (TO CURRENT_USER). The application's runtime role is a different role, so none of this opens
-- anything to tenant sessions or to a compromised application: it still cannot create organizations or touch system roles.
CREATE POLICY org_bootstrap_insert ON organizations FOR INSERT TO CURRENT_USER WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY roles_owner_write ON roles FOR ALL TO CURRENT_USER
  USING (org_id IS NULL AND is_system) WITH CHECK (org_id IS NULL AND is_system);
--> statement-breakpoint
CREATE POLICY rp_owner_write ON role_permissions FOR ALL TO CURRENT_USER
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.org_id IS NULL AND r.is_system))
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.org_id IS NULL AND r.is_system));
