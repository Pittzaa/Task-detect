/** The address that opens a task: the tasks page shows the task in its drawer when `?task=` is present. There is no `/tasks/<id>` page. */
export function taskLink(appUrl: string, orgId: string, taskId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/o/${encodeURIComponent(orgId)}/tasks?task=${encodeURIComponent(taskId)}`;
}

/** The page every e-mail's button opens: the person's own tasks. (`/o/<orgId>` alone is not a page.) */
export function myTasksLink(appUrl: string, orgId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/o/${encodeURIComponent(orgId)}/my-tasks`;
}
