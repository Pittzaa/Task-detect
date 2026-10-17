import { describe, expect, it } from "vitest";
import { can, type Principal, type ResolvedAssignment } from "@/authz/evaluate";
import type { Permission } from "@/authz/permissions";

const ORG = "org-1";
const perms = (...p: Permission[]) => new Set<Permission>(p);

const principal = (assignments: ResolvedAssignment[], over: Partial<Principal> = {}): Principal => ({
  userId: "u1",
  orgId: ORG,
  membershipStatus: "approved",
  assignments,
  ...over,
});

describe("can()", () => {
  it("denies by default with no assignments", () => {
    expect(can(principal([]), "task.read", { orgId: ORG })).toBe(false);
  });

  it("organization scope covers every resource in the org", () => {
    const p = principal([{ scopeType: "organization", permissions: perms("project.read") }]);
    expect(can(p, "project.read", { orgId: ORG, projectId: "p1" })).toBe(true);
    expect(can(p, "project.read", { orgId: ORG, teamId: "t1", departmentId: "d1" })).toBe(true);
  });

  it("denies a permission the role does not carry", () => {
    const p = principal([{ scopeType: "organization", permissions: perms("project.read") }]);
    expect(can(p, "project.update", { orgId: ORG })).toBe(false);
  });

  it("denies resources in another organization even with org-wide permissions", () => {
    const p = principal([{ scopeType: "organization", permissions: perms("project.read") }]);
    expect(can(p, "project.read", { orgId: "org-2" })).toBe(false);
  });

  it("team scope applies to that team only", () => {
    const p = principal([{ scopeType: "team", teamId: "t1", permissions: perms("team.manage") }]);
    expect(can(p, "team.manage", { orgId: ORG, teamId: "t1" })).toBe(true);
    expect(can(p, "team.manage", { orgId: ORG, teamId: "t2" })).toBe(false);
    expect(can(p, "team.manage", { orgId: ORG })).toBe(false);
  });

  it("department scope covers the department and its teams, not siblings", () => {
    const p = principal([{ scopeType: "department", departmentId: "d1", permissions: perms("team.manage") }]);
    expect(can(p, "team.manage", { orgId: ORG, departmentId: "d1", teamId: "t9" })).toBe(true);
    expect(can(p, "team.manage", { orgId: ORG, departmentId: "d2", teamId: "t1" })).toBe(false);
  });

  it("project scope applies to that project only", () => {
    const p = principal([{ scopeType: "project", projectId: "p1", permissions: perms("task.update") }]);
    expect(can(p, "task.update", { orgId: ORG, projectId: "p1" })).toBe(true);
    expect(can(p, "task.update", { orgId: ORG, projectId: "p2" })).toBe(false);
  });

  it("a scoped assignment with a missing scope id grants nothing", () => {
    const p = principal([{ scopeType: "team", teamId: null, permissions: perms("team.manage") }]);
    expect(can(p, "team.manage", { orgId: ORG, teamId: null })).toBe(false);
  });

  it("unions multiple assignments (manager in Team A, viewer in Project B)", () => {
    const p = principal([
      { scopeType: "team", teamId: "tA", permissions: perms("task.update", "task.read") },
      { scopeType: "project", projectId: "pB", permissions: perms("task.read") },
    ]);
    expect(can(p, "task.update", { orgId: ORG, teamId: "tA" })).toBe(true);
    expect(can(p, "task.update", { orgId: ORG, projectId: "pB" })).toBe(false);
    expect(can(p, "task.read", { orgId: ORG, projectId: "pB" })).toBe(true);
  });

  it.each(["pending", "suspended", "revoked"] as const)("denies everything for a %s membership", (status) => {
    const p = principal([{ scopeType: "organization", permissions: perms("task.read") }], { membershipStatus: status });
    expect(can(p, "task.read", { orgId: ORG })).toBe(false);
  });
});
