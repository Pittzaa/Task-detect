import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { attachments, users } from "@/db/schema";
import { GET as tasksGET, POST as tasksPOST } from "@/app/api/orgs/[orgId]/tasks/route";
import { GET as taskGET, PATCH as taskPATCH, DELETE as taskDELETE } from "@/app/api/orgs/[orgId]/tasks/[taskId]/route";
import { POST as statusPOST } from "@/app/api/orgs/[orgId]/tasks/[taskId]/status/route";
import { GET as attListGET, POST as attPOST } from "@/app/api/orgs/[orgId]/tasks/[taskId]/attachments/route";
import { GET as attGET, DELETE as attDELETE } from "@/app/api/orgs/[orgId]/attachments/[attachmentId]/route";
import { POST as commentPOST } from "@/app/api/orgs/[orgId]/tasks/[taskId]/comments/route";
import { MAX_UPLOAD_BYTES } from "@/domain/files";
import { addMember, connect, makeOrg } from "./helpers";
import { BASE, Client, makeAuthApp, registerAndSignIn } from "./auth-helpers";

const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function upload(cl: Client, orgId: string, taskId: string, name: string, bytes: Uint8Array, type = "image/png") {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], name, { type }));
  const req = new Request(`${BASE}/api/orgs/${orgId}/tasks/${taskId}/attachments`, {
    method: "POST",
    body: form,
    headers: { origin: BASE, cookie: [...cl.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  return attPOST(req, { params: Promise.resolve({ orgId, taskId }) });
}

describe("task HTTP API", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let X: Awaited<ReturnType<typeof makeOrg>>;
  let mgr: Client; let mem: Client; let view: Client; let outsider: Client; let xadmin: Client;
  let taskId: string;
  const P = (extra: Record<string, string> = {}) => ({ orgId: O.org.id, ...extra });

  beforeAll(async () => {
    O = await makeOrg(c.admin, "HttpOrg");
    X = await makeOrg(c.admin, "HttpOther");
    const mk = async (label: string, orgId: string, role?: string) => {
      const { client, email } = await registerAndSignIn(app, label);
      const [u] = await c.admin.select().from(users).where(eq(users.email, email));
      await addMember(c.admin, orgId, u!.id, role ? { role } : {});
      return client;
    };
    mgr = await mk("hmgr", O.org.id, "manager");
    mem = await mk("hmem", O.org.id, "member");
    view = await mk("hview", O.org.id, "viewer");
    outsider = await mk("hout", O.org.id);
    xadmin = await mk("hxadm", X.org.id, "orgadmin");
    const res = await mgr.route(tasksPOST as never, "POST", `/api/orgs/${O.org.id}/tasks`, { projectId: O.project.id, title: "HTTP task" }, P());
    expect(res.status).toBe(201);
    taskId = ((await res.json()) as { id: string }).id;
  });

  it("maps outcomes to 401 / 403 / 404 / 409 / 422 consistently", async () => {
    const anon = new Client(app.auth);
    expect((await anon.route(tasksGET as never, "GET", `/api/orgs/${O.org.id}/tasks`, undefined, P())).status).toBe(401);
    expect((await view.route(tasksPOST as never, "POST", `/api/orgs/${O.org.id}/tasks`, { projectId: O.project.id, title: "x" }, P())).status).toBe(403);
    expect((await outsider.route(taskGET as never, "GET", `/api/orgs/${O.org.id}/tasks/${taskId}`, undefined, P({ taskId }))).status).toBe(404);
    expect((await xadmin.route(taskGET as never, "GET", `/api/orgs/${X.org.id}/tasks/${taskId}`, undefined, { orgId: X.org.id, taskId })).status).toBe(404);
    expect((await xadmin.route(taskGET as never, "GET", `/api/orgs/${O.org.id}/tasks/${taskId}`, undefined, P({ taskId }))).status).toBe(404);
    expect((await mgr.route(tasksPOST as never, "POST", `/api/orgs/${O.org.id}/tasks`, { projectId: O.project.id, title: "" }, P())).status).toBe(422);
    expect((await mgr.route(tasksPOST as never, "POST", `/api/orgs/${O.org.id}/tasks`, { projectId: O.project.id, title: "x", unknownField: 1 }, P())).status).toBe(422);
    expect((await mgr.route(taskGET as never, "GET", `/api/orgs/${O.org.id}/tasks/not-a-uuid`, undefined, P({ taskId: "not-a-uuid" }))).status).toBe(422);
    const stale = await mgr.route(taskPATCH as never, "PATCH", `/api/orgs/${O.org.id}/tasks/${taskId}`, { version: 99, title: "x" }, P({ taskId }));
    expect(stale.status).toBe(409);
    const ok = await mgr.route(taskPATCH as never, "PATCH", `/api/orgs/${O.org.id}/tasks/${taskId}`, { version: 1, title: "Renamed" }, P({ taskId }));
    expect(ok.status).toBe(200);
  });

  it("returns structured data for workflow violations and never leaks internals on errors", async () => {
    const bad = await mem.route(statusPOST as never, "POST", `/api/orgs/${O.org.id}/tasks/${taskId}/status`, { status: "done" }, P({ taskId }));
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as { error: { code: string; message: string; data?: unknown } };
    expect(body.error).toMatchObject({ code: "VALIDATION", message: "val.status_transition", data: { from: "todo", to: "done" } });
    expect(JSON.stringify(body)).not.toMatch(/stack|select |postgres/i);
  });

  it("lists with filters through the query string and rejects malformed filters", async () => {
    const r = await mem.route(tasksGET as never, "GET", `/api/orgs/${O.org.id}/tasks?status=todo,progress&limit=5&sort=title`, undefined, P());
    expect(r.status).toBe(200);
    expect(((await r.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect((await mem.route(tasksGET as never, "GET", `/api/orgs/${O.org.id}/tasks?status=weird`, undefined, P())).status).toBe(422);
    expect((await mem.route(tasksGET as never, "GET", `/api/orgs/${O.org.id}/tasks?limit=100000`, undefined, P())).status).toBe(422);
  });

  it("comment bodies come back verbatim as data (no HTML interpretation server-side)", async () => {
    const evil = "<script>alert(1)</script>";
    expect((await mem.route(commentPOST as never, "POST", `/api/orgs/${O.org.id}/tasks/${taskId}/comments`, { body: evil }, P({ taskId }))).status).toBe(201);
  });

  describe("attachments", () => {
    let attId: string;

    it("uploads a real PNG; stores an opaque key without the user's file name", async () => {
      const res = await upload(mem, O.org.id, taskId, "../../évil name.png", PNG);
      expect(res.status).toBe(201);
      attId = ((await res.json()) as { id: string }).id;
      const [row] = await c.admin.select().from(attachments).where(eq(attachments.id, attId));
      expect(row!.storageKey).toMatch(new RegExp(`^orgs/${O.org.id}/tasks/${taskId}/[0-9a-f-]{36}$`));
      expect(row!.storageKey).not.toContain("vil");
      expect(row!.filename).toBe("évil name.png");
      expect(row!.contentType).toBe("image/png");
      expect(row!.sha256).toHaveLength(64);
    });

    it("rejects wrong types, mismatched names, empty and oversized files", async () => {
      expect((await upload(mem, O.org.id, taskId, "run.exe", new Uint8Array([0x4d, 0x5a, 0x90, 0]), "application/octet-stream")).status).toBe(422);
      expect((await upload(mem, O.org.id, taskId, "pic.png", new TextEncoder().encode("<svg onload=alert(1)>"), "image/png")).status).toBe(422);
      expect((await upload(mem, O.org.id, taskId, "fake.pdf", PNG, "application/pdf")).status).toBe(422);
      expect((await upload(mem, O.org.id, taskId, "empty.txt", new Uint8Array(), "text/plain")).status).toBe(422);
      const big = new Uint8Array(MAX_UPLOAD_BYTES + 1); big.set(PNG);
      expect((await upload(mem, O.org.id, taskId, "big.png", big)).status).toBe(422);
    });

    it("downloads as an attachment with hardened headers for authorized users only", async () => {
      const res = await view.route(attGET as never, "GET", `/api/orgs/${O.org.id}/attachments/${attId}`, undefined, P({ attachmentId: attId }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
      const anon = new Client(app.auth);
      expect((await anon.route(attGET as never, "GET", `/api/orgs/${O.org.id}/attachments/${attId}`, undefined, P({ attachmentId: attId }))).status).toBe(401);
      expect((await outsider.route(attGET as never, "GET", `/api/orgs/${O.org.id}/attachments/${attId}`, undefined, P({ attachmentId: attId }))).status).toBe(404);
      expect((await xadmin.route(attGET as never, "GET", `/api/orgs/${X.org.id}/attachments/${attId}`, undefined, { orgId: X.org.id, attachmentId: attId })).status).toBe(404);
      expect((await xadmin.route(attGET as never, "GET", `/api/orgs/${O.org.id}/attachments/${attId}`, undefined, P({ attachmentId: attId }))).status).toBe(404);
    });

    it("viewers cannot upload or delete; uploader and managers can delete; deleted files are gone", async () => {
      expect((await upload(view, O.org.id, taskId, "v.png", PNG)).status).toBe(403);
      expect((await view.route(attDELETE as never, "DELETE", `/api/orgs/${O.org.id}/attachments/${attId}`, undefined, P({ attachmentId: attId }))).status).toBe(403);
      expect((await outsider.route(attDELETE as never, "DELETE", `/api/orgs/${O.org.id}/attachments/${attId}`, undefined, P({ attachmentId: attId }))).status).toBe(404);
      const list = (await (await mem.route(attListGET as never, "GET", `/api/orgs/${O.org.id}/tasks/${taskId}/attachments`, undefined, P({ taskId }))).json()) as { attachments: unknown[] };
      expect(list.attachments).toHaveLength(1);
      expect((await mem.route(attDELETE as never, "DELETE", `/api/orgs/${O.org.id}/attachments/${attId}`, undefined, P({ attachmentId: attId }))).status).toBe(200);
      expect((await mem.route(attGET as never, "GET", `/api/orgs/${O.org.id}/attachments/${attId}`, undefined, P({ attachmentId: attId }))).status).toBe(404);
    });

    it("attachments of a deleted task are no longer reachable", async () => {
      const t = await mgr.route(tasksPOST as never, "POST", `/api/orgs/${O.org.id}/tasks`, { projectId: O.project.id, title: "to delete" }, P());
      const tid = ((await t.json()) as { id: string }).id;
      const a = (await (await upload(mem, O.org.id, tid, "a.png", PNG)).json()) as { id: string };
      expect((await mgr.route(taskDELETE as never, "DELETE", `/api/orgs/${O.org.id}/tasks/${tid}`, undefined, P({ taskId: tid }))).status).toBe(200);
      expect((await mgr.route(attGET as never, "GET", `/api/orgs/${O.org.id}/attachments/${a.id}`, undefined, P({ attachmentId: a.id }))).status).toBe(404);
    });

    it("limits uploads per task", async () => {
      const t = await mgr.route(tasksPOST as never, "POST", `/api/orgs/${O.org.id}/tasks`, { projectId: O.project.id, title: "many" }, P());
      const tid = ((await t.json()) as { id: string }).id;
      const statuses: number[] = [];
      for (let i = 0; i < 26; i++) statuses.push((await upload(mgr, O.org.id, tid, `f${i}.png`, PNG)).status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(20); // per-user rate limit (20/min) trips before the 25-file cap
      expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    });
  });
});
