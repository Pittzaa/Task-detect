# Phase 1 status

| Item | State |
|---|---|
| Tooling (TS strict, ESLint, Vitest, Drizzle, Next build) | Done, verified locally |
| Env validation, typed errors, redacting logger | Done, unit-tested |
| Core schema + versioned migrations | Done, applied to local PostgreSQL 16 |
| Scoped RBAC (catalog, evaluator, system roles) | Done, unit- and integration-tested |
| Tenant isolation (app layer + RLS, `withTenant`) | Done, integration-tested incl. mutation checks |
| Audit of authorization denials | Done for denials and department/team/project creation |
| **Authentication** (email/password, Google, MFA, sessions, reset) | **Not started** |
| **Account lifecycle** (self-registration + approval, invitations) | **Not started** (schema for memberships/invitations exists) |
| Vercel deployment skeleton, `docs/DEPLOYMENT.md`, `SECURITY.md`, `ADMIN_GUIDE.md` | Not started |
| Verification against real Neon (pooler, roles) | **Unverified** |

Blocker for the auth step: the Better Auth capabilities (Google, 2FA, session revocation) are not yet
confirmed against official documentation, and vercel.com / neon.com were unreachable from the build sandbox.
