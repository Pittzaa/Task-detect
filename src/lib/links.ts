/** The address that opens a task: the tasks page shows the task in its drawer when `?task=` is present. There is no `/tasks/<id>` page. */
export function taskLink(appUrl: string, orgId: string, taskId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/o/${encodeURIComponent(orgId)}/tasks?task=${encodeURIComponent(taskId)}`;
}
