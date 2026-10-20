"use client";
import { createContext, useContext } from "react";

export interface OrgCtx {
  orgId: string;
  org: { id: string; name: string; appName: string };
  can: Record<string, boolean>;
  user: { id: string; name: string; email: string; locale: "th" | "en"; timezone: string };
  hasAnyAccess: boolean;
}
export const OrgContext = createContext<OrgCtx | null>(null);
export function useOrg(): OrgCtx {
  const v = useContext(OrgContext);
  if (!v) throw new Error("useOrg must be used inside the organization shell");
  return v;
}
