import { describe, expect, it } from "vitest";
import { PERMISSIONS, SYSTEM_ROLE_KEYS, SYSTEM_ROLE_PERMISSIONS } from "@/authz/permissions";

describe("permission catalog", () => {
  it("has no duplicates", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("every system role only references catalog permissions", () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      for (const p of SYSTEM_ROLE_PERMISSIONS[key]) expect(PERMISSIONS).toContain(p);
    }
  });

  it("orgadmin holds every permission", () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.orgadmin].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("viewer is read-only", () => {
    for (const p of SYSTEM_ROLE_PERMISSIONS.viewer) expect(p.endsWith(".read")).toBe(true);
  });

  it("only orgadmin can administer roles, members, integrations and the audit log", () => {
    const admin = ["org.manage_roles", "org.manage_members", "org.approve_members", "org.manage_integrations", "org.read_audit_log"] as const;
    for (const key of ["manager", "member", "viewer"] as const) {
      for (const p of admin) expect(SYSTEM_ROLE_PERMISSIONS[key]).not.toContain(p);
    }
  });

  it("superadmin is not an organization role", () => {
    expect(SYSTEM_ROLE_KEYS as readonly string[]).not.toContain("superadmin");
  });
});
