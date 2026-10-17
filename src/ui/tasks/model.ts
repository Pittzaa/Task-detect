import type { TaskPriority, TaskStatus } from "@/domain/workflow";
export type { TaskSummary } from "@/data/tasks";

export const VIEWS = ["list", "board", "calendar", "timeline"] as const;
export type ViewName = (typeof VIEWS)[number];

export interface Filters {
  view: ViewName;
  project?: string;
  status: TaskStatus[];
  priority: TaskPriority[];
  assignee?: string; // "me" | user id
  label?: string;
  q?: string;
  overdue?: boolean;
  topLevel?: boolean;
  sort?: "due" | "priority" | "created" | "updated" | "title";
  order?: "asc" | "desc";
  dueFrom?: string;
  dueTo?: string;
}

const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

export function parseFilters(sp: URLSearchParams): Filters {
  const view = sp.get("view");
  return {
    view: (VIEWS as readonly string[]).includes(view ?? "") ? (view as ViewName) : "list",
    project: sp.get("project") ?? undefined,
    status: csv(sp.get("status")) as TaskStatus[],
    priority: csv(sp.get("priority")) as TaskPriority[],
    assignee: sp.get("assignee") ?? undefined,
    label: sp.get("label") ?? undefined,
    q: sp.get("q") ?? undefined,
    overdue: sp.get("overdue") === "1" || undefined,
    topLevel: sp.get("top") === "1" || undefined,
    sort: (sp.get("sort") as Filters["sort"]) ?? undefined,
    order: (sp.get("order") as Filters["order"]) ?? undefined,
    dueFrom: sp.get("dueFrom") ?? undefined,
    dueTo: sp.get("dueTo") ?? undefined,
  };
}

export function toUrlParams(f: Filters, extra: Record<string, string | undefined> = {}): URLSearchParams {
  const p = new URLSearchParams();
  if (f.view !== "list") p.set("view", f.view);
  if (f.project) p.set("project", f.project);
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.priority.length) p.set("priority", f.priority.join(","));
  if (f.assignee) p.set("assignee", f.assignee);
  if (f.label) p.set("label", f.label);
  if (f.q) p.set("q", f.q);
  if (f.overdue) p.set("overdue", "1");
  if (f.topLevel) p.set("top", "1");
  if (f.sort) p.set("sort", f.sort);
  if (f.order) p.set("order", f.order);
  if (f.dueFrom) p.set("dueFrom", f.dueFrom);
  if (f.dueTo) p.set("dueTo", f.dueTo);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p;
}

/** Query string for GET /tasks. */
export function toApiQuery(f: Filters, extra: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams();
  if (f.project) p.set("projectId", f.project);
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.priority.length) p.set("priority", f.priority.join(","));
  if (f.assignee) p.set("assignee", f.assignee);
  if (f.label) p.set("labelId", f.label);
  if (f.q) p.set("q", f.q);
  if (f.overdue) p.set("overdue", "true");
  if (f.topLevel) p.set("topLevelOnly", "true");
  if (f.sort) p.set("sort", f.sort);
  if (f.order) p.set("order", f.order);
  if (f.dueFrom) p.set("dueFrom", f.dueFrom);
  if (f.dueTo) p.set("dueTo", f.dueTo);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
}

export const isOverdue = (due: string | null, status: TaskStatus, today: string) => !!due && due < today && status !== "done" && status !== "cancelled";
