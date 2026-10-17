# Entity relationship diagram (Phase 1 schema)

Every tenant table has `org_id NOT NULL`. Child tables reference parents through composite foreign
keys `(org_id, id)` so cross-organization references are impossible at the database level.

```mermaid
erDiagram
  organizations ||--o{ memberships : has
  users ||--o{ memberships : joins
  organizations ||--o{ departments : has
  departments ||--o{ teams : has
  organizations ||--o{ projects : has
  projects ||--o{ project_teams : links
  teams ||--o{ project_teams : links
  roles ||--o{ role_permissions : grants
  memberships ||--o{ role_assignments : holds
  roles ||--o{ role_assignments : used_by
  departments ||--o{ role_assignments : scope
  teams ||--o{ role_assignments : scope
  projects ||--o{ role_assignments : scope
  organizations ||--o{ invitations : issues
  organizations ||--o{ audit_logs : records
  users ||--o{ audit_logs : acts
```

Notes
- `roles.org_id IS NULL` marks a system role (`roles_system_has_no_org` check).
- `role_assignments_scope_matches` check: `scope_type` must match exactly one non-null scope column.
- `users` is global (an email belongs to one platform account); access is always via `memberships`.
- Authentication tables (accounts, sessions, verification, MFA) are not part of this schema yet.
- Soft delete: `deleted_at` on organizations, users, departments, teams, projects. Queries must filter it.
