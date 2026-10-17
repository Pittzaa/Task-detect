import { createTask, listTasks } from "@/data/tasks";
import { handle, readJson, readQuery } from "@/server/api";
import { createTaskBody, taskQuery } from "@/server/schemas";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const q = readQuery(req, taskQuery);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: c.user.timezone }).format(new Date());
    const { items, hasMore } = await c.tenant((await params).orgId, (s) => listTasks(s, { ...q, today }));
    return { items, hasMore };
  });
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, createTaskBody);
    return c.tenant((await params).orgId, (s) => createTask(s, body));
  }, { status: 201 });
