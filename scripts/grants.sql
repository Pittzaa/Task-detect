-- Least-privilege grants for the application runtime role. Run once per environment AFTER migrations,
-- as the owner/admin role. Replace {{APP_ROLE}}. The role must not be a superuser and must not have
-- BYPASSRLS (create it with: CREATE ROLE ... LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;).
GRANT USAGE ON SCHEMA public TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {{APP_ROLE}};
-- Audit logs are append-only for the application.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM {{APP_ROLE}};
-- System roles/organizations are managed by the admin path, not by tenant sessions.
REVOKE INSERT, UPDATE, DELETE ON organizations FROM {{APP_ROLE}};
-- ...except the one setting organization administrators may change themselves (the RLS policy org_update limits it to their own organization).
GRANT UPDATE (registration_open) ON organizations TO {{APP_ROLE}};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO {{APP_ROLE}};
-- Read-only view of the applied-migrations list, so /api/health/ready can detect a deployment that is ahead of its database.
GRANT USAGE ON SCHEMA drizzle TO {{APP_ROLE}};
GRANT SELECT ON drizzle.__drizzle_migrations TO {{APP_ROLE}};
