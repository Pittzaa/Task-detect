# RBAC

## Concepts
- **Role**: a named set of permissions. System roles (`orgadmin`, `manager`, `member`, `viewer`) are
  global rows with `org_id IS NULL`; **custom** roles belong to one organization.
- **Role assignment**: `(membership, role, scope)`. Role and scope are separate, so one user can be
  `manager` in Team A and `viewer` in Project B.
- **Scope**: `organization | department | team | project`. Exactly one scope column is set and each is a
  composite foreign key `(org_id, id)`, so a scope can never point into another organization.
  A `task` scope is deferred to Phase 2.
- **`superadmin`** is *not* an organization role. It is a platform flag (`users.is_platform_admin`).
  Its powers are not yet implemented; the proposed policy (no task/file content access without an
  audited organization entry) is an open decision in `PHASE0_PROPOSAL.md`.

## Evaluation rules (`src/authz/evaluate.ts`)
1. Membership must be `approved`; otherwise deny. `pending`, `suspended`, `revoked` reach nothing.
2. The resource's `orgId` must equal the principal's `orgId`.
3. A permission is granted if **any** assignment both carries it and whose scope covers the resource.
4. Coverage: `organization` covers everything in the org; `department` covers that department and
   resources whose `departmentId` matches; `team` / `project` cover only resources carrying that exact id.
5. No assignments match -> deny. There are **no explicit denies**; effective rights are the union.
6. Unknown permission strings stored in the database grant nothing.

Resource scope ids passed to `require()` must come from the database, never from the request.

## Known behaviour to be aware of
- A `team`-scoped assignment does **not** grant organization-level reads, e.g. listing all projects
  (covered by tests). Whether a project should inherit rights from its participating teams is not decided.
- The scope chain of a resource (its department/team/project ids) is supplied by the caller to
  `require()`. Callers loading a resource must pass its real chain; this will be centralised per entity in Phase 2.

## System role permissions
Defined in `src/authz/permissions.ts` (`SYSTEM_ROLE_PERMISSIONS`) and synced to the database by
`syncSystemRoles`. Summary:

| Capability | orgadmin | manager | member | viewer |
|---|:-:|:-:|:-:|:-:|
| Read org / departments / teams / projects / tasks | yes | yes | yes | yes |
| Create/update tasks, change status, comment | yes | yes | yes | no |
| Delete/assign tasks, manage dependencies | yes | yes | no | no |
| Create/update projects, manage project/team members | yes | yes | no | no |
| Manage departments, teams, delete projects | yes | no | no | no |
| Approve/manage members, roles, integrations, custom fields, read audit log | yes | no | no | no |

Only some of these permissions are exercised by Phase 1 code (`department.*`, `team.manage`,
`project.*`). Task permissions exist in the catalog for Phase 2.
