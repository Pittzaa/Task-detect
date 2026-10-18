import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getPayloadFromClientToken } from "@vercel/blob/client";
import { authorizeDirectUpload, finalizeDirectUpload, openAttachment } from "@/data/attachments";
import { createTask } from "@/data/tasks";
import { withTenant } from "@/data/tenant";
import { attachments, auditLogs } from "@/db/schema";
import { MAX_DIRECT_UPLOAD_BYTES, MAX_ATTACHMENTS_PER_TASK, isDirectUploadKey } from "@/domain/files";
import { sha256Hex } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { setRuntimeForTests } from "@/server/runtime";
import { POST as tokenRoute } from "@/app/api/orgs/[orgId]/tasks/[taskId]/attachments/direct/route";
import { POST as completeRoute } from "@/app/api/orgs/[orgId]/tasks/[taskId]/attachments/direct/complete/route";
import { GET as listRoute } from "@/app/api/orgs/[orgId]/tasks/[taskId]/attachments/route";
import { Client, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { users } from "@/db/schema";

const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);
const store = app.store;
const FAKE_BLOB_TOKEN = "vercel_blob_rw_teststore123_0123456789abcdef0123456789abcdef";

let O: Awaited<ReturnType<typeof makeOrg>>;
let X: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
let taskA = "";
let taskB = "";
let web: { client: Client; id: string };

const pdf = (size: number) => { const b = Buffer.alloc(size, 0x20); b.write("%PDF-1.7\n"); return b; };
const as = (k: string, org = O.org.id) => ({ userId: u[k]!.id, orgId: org });
const keyFor = (task = taskA, org = O.org.id) => `orgs/${org}/tasks/${task}/${randomUUID()}`;
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2], org?: string) => withTenant(c.app, as(k, org), fn);
async function code(p: Promise<unknown>) { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? `${e.code}:${e.message}` : `RAW:${(e as Error).message}`; } }
/** What the browser's upload to the store amounts to, as far as the server can tell. */
const arrives = (key: string, bytes: Buffer) => store.put(key, bytes);
const rows = (taskId: string) => c.admin.select().from(attachments).where(eq(attachments.taskId, taskId));

beforeAll(async () => {
  O = await makeOrg(c.admin, "DirectOrg");
  X = await makeOrg(c.admin, "DirectOther");
  for (const k of ["admin", "member", "viewer", "xadmin"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.member!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.viewer!.id, { role: "viewer" });
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
  taskA = (await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Direct A" }))).id;
  taskB = (await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Direct B" }))).id;
  const reg = await registerAndSignIn(app, "direct");
  const [row] = await c.admin.select({ id: users.id }).from(users).where(eq(users.email, reg.email));
  await addMember(c.admin, O.org.id, row!.id, { role: "member" });
  web = { client: reg.client, id: row!.id };
});

describe("object names", () => {
  it("accepts only orgs/<this org>/tasks/<this task>/<uuid>", () => {
    const o = O.org.id, t = taskA, id = randomUUID();
    expect(isDirectUploadKey(`orgs/${o}/tasks/${t}/${id}`, o, t)).toBe(true);
    for (const bad of [
      `orgs/${X.org.id}/tasks/${t}/${id}`, `orgs/${o}/tasks/${taskB}/${id}`, `orgs/${o}/tasks/${t}/${id}.pdf`, `orgs/${o}/tasks/${t}/${id}/x`, `orgs/${o}/tasks/${t}/../${id}`,
      `/orgs/${o}/tasks/${t}/${id}`, `orgs/${o}/tasks/${t}/not-a-uuid`, `orgs/${o}/tasks/${t}/${id}\n`, `orgs/${o}//tasks/${t}/${id}`, "",
    ]) expect(isDirectUploadKey(bad, o, t), bad).toBe(false);
    // the org and task are interpolated into a pattern: they must not be able to inject one
    expect(isDirectUploadKey(`orgs/x/tasks/y/${id}`, "x", "y")).toBe(false);
    expect(isDirectUploadKey(`orgs/${o}/tasks/${t}/${id}`, ".*", ".*")).toBe(false);
  });

  it("accepts one spelling only (lower case): object names are case-sensitive and the cleanup sweep lists the lower-case prefix", () => {
    const o = O.org.id, t = taskA, id = randomUUID();
    expect(isDirectUploadKey(`orgs/${o.toUpperCase()}/tasks/${t}/${id}`, o, t)).toBe(false);
    expect(isDirectUploadKey(`orgs/${o}/tasks/${t.toUpperCase()}/${id}`, o, t)).toBe(false);
    expect(isDirectUploadKey(`orgs/${o}/tasks/${t}/${id.toUpperCase()}`, o, t)).toBe(false);
    expect(isDirectUploadKey(`orgs/${o.toUpperCase()}/tasks/${t}/${id}`, o.toUpperCase(), t)).toBe(false);
  });
});

describe("step 1: permission to receive an upload token", () => {
  it("lets someone who can attach files, and nobody else", async () => {
    expect(await code(run("member", (s) => authorizeDirectUpload(s, taskA, keyFor())))).toBe("OK");
    expect(await code(run("viewer", (s) => authorizeDirectUpload(s, taskA, keyFor())))).toBe("FORBIDDEN:Not allowed");
    expect(await code(run("xadmin", (s) => authorizeDirectUpload(s, taskA, keyFor()), X.org.id))).toMatch(/^NOT_FOUND/); // other tenant
    expect(await code(run("member", (s) => authorizeDirectUpload(s, taskA, keyFor(taskB))))).toMatch(/^VALIDATION/); // a name for another task
    expect(await code(run("member", (s) => authorizeDirectUpload(s, taskA, keyFor(taskA, X.org.id))))).toMatch(/^VALIDATION/); // a name in another organization
  });

  it("tells the token endpoint the size limit, and refuses once the task is full", async () => {
    const t = (await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Full" }))).id;
    expect((await run("member", (s) => authorizeDirectUpload(s, t, keyFor(t)))).maximumSizeInBytes).toBe(MAX_DIRECT_UPLOAD_BYTES);
    for (let i = 0; i < MAX_ATTACHMENTS_PER_TASK; i++) await c.admin.insert(attachments).values({ orgId: O.org.id, taskId: t, uploadedBy: u.admin!.id, storageKey: `orgs/${O.org.id}/tasks/${t}/${randomUUID()}`, filename: "f.pdf", contentType: "application/pdf", sizeBytes: 5, sha256: "ab".repeat(32) });
    expect(await code(run("member", (s) => authorizeDirectUpload(s, t, keyFor(t))))).toMatch(/^VALIDATION:Too many/);
  });
});

describe("step 2: the server inspects what arrived", () => {
  it("registers a large file using its own measurements, not the browser's claims; the bytes round-trip", async () => {
    const bytes = pdf(6_000_000);
    const key = keyFor();
    await arrives(key, bytes);
    const row = await run("member", (s) => finalizeDirectUpload(s, store, taskA, { key, name: "Quarterly report.pdf" }));
    expect(row).toMatchObject({ filename: "Quarterly report.pdf", contentType: "application/pdf", sizeBytes: 6_000_000 });
    const [stored] = await c.admin.select().from(attachments).where(eq(attachments.id, row.id));
    expect(stored).toMatchObject({ storageKey: key, sha256: sha256Hex(bytes), uploadedBy: u.member!.id, orgId: O.org.id, taskId: taskA });
    const audit = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.targetId, row.id), eq(auditLogs.action, "attachment.upload")));
    expect(audit).toHaveLength(1);
    const opened = await run("admin", (s) => openAttachment(s, store, row.id));
    expect(Buffer.from(await new Response(opened.stream).arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("decides the type from the bytes: an HTML page uploaded as 'x.pdf' is refused and deleted from the store", async () => {
    const key = keyFor();
    await arrives(key, Buffer.from("<html><script>alert(1)</script></html>".repeat(5000)));
    expect(await code(run("member", (s) => finalizeDirectUpload(s, store, taskA, { key, name: "x.pdf" })))).toMatch(/^VALIDATION:This file type is not allowed/);
    expect(await store.get(key)).toBeNull();
    expect(await c.admin.select().from(attachments).where(eq(attachments.storageKey, key))).toHaveLength(0);
  });

  it("refuses a file over 25 MB even if the store accepted it, and deletes it", async () => {
    const key = keyFor();
    await arrives(key, pdf(MAX_DIRECT_UPLOAD_BYTES + 1));
    expect(await code(run("member", (s) => finalizeDirectUpload(s, store, taskA, { key, name: "huge.pdf" })))).toMatch(/^VALIDATION:File is too large/);
    expect(await store.get(key)).toBeNull();
    const ok = keyFor();
    await arrives(ok, pdf(MAX_DIRECT_UPLOAD_BYTES));
    expect((await run("member", (s) => finalizeDirectUpload(s, store, taskA, { key: ok, name: "exactly-25mb.pdf" }))).sizeBytes).toBe(MAX_DIRECT_UPLOAD_BYTES);
  });

  it("refuses an empty object, and a claim for an object that never arrived", async () => {
    const empty = keyFor();
    await arrives(empty, Buffer.alloc(0));
    expect(await code(run("member", (s) => finalizeDirectUpload(s, store, taskA, { key: empty, name: "empty.pdf" })))).toMatch(/^VALIDATION:File is empty/);
    expect(await code(run("member", (s) => finalizeDirectUpload(s, store, taskA, { key: keyFor(), name: "ghost.pdf" })))).toMatch(/^VALIDATION:The upload did not arrive/);
  });

  it("is idempotent for the same person, and refuses reuse of a name by anyone else or on another task", async () => {
    const key = keyFor();
    await arrives(key, pdf(5000));
    const first = await run("member", (s) => finalizeDirectUpload(s, store, taskA, { key, name: "once.pdf" }));
    const second = await run("member", (s) => finalizeDirectUpload(s, store, taskA, { key, name: "once.pdf" }));
    expect(second.id).toBe(first.id);
    expect(await c.admin.select().from(attachments).where(eq(attachments.storageKey, key))).toHaveLength(1);
    expect(await code(run("admin", (s) => finalizeDirectUpload(s, store, taskA, { key, name: "once.pdf" })))).toMatch(/^CONFLICT/);
    expect(await code(run("admin", (s) => finalizeDirectUpload(s, store, taskB, { key, name: "once.pdf" })))).toMatch(/^VALIDATION:Invalid upload path/);
  });

  it("applies the same permission and tenant rules as a normal upload, and does not delete another person's object when refusing", async () => {
    const key = keyFor();
    await arrives(key, pdf(5000));
    expect(await code(run("viewer", (s) => finalizeDirectUpload(s, store, taskA, { key, name: "v.pdf" })))).toBe("FORBIDDEN:Not allowed");
    expect(await code(run("xadmin", (s) => finalizeDirectUpload(s, store, taskA, { key, name: "x.pdf" }), X.org.id))).toMatch(/^NOT_FOUND/);
    expect(await store.get(key)).not.toBeNull(); // a refused caller cannot make the server delete the object
  });

  it("two simultaneous completions never exceed the per-task limit", async () => {
    const t = (await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Race" }))).id;
    for (let i = 0; i < MAX_ATTACHMENTS_PER_TASK - 1; i++) await c.admin.insert(attachments).values({ orgId: O.org.id, taskId: t, uploadedBy: u.admin!.id, storageKey: `orgs/${O.org.id}/tasks/${t}/${randomUUID()}`, filename: "f.pdf", contentType: "application/pdf", sizeBytes: 5, sha256: "ab".repeat(32) });
    const keys = [keyFor(t), keyFor(t), keyFor(t)];
    for (const k of keys) await arrives(k, pdf(2000));
    const results = await Promise.all(keys.map((k, i) => code(run("member", (s) => finalizeDirectUpload(s, store, t, { key: k, name: `r${i}.pdf` })))));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect((await rows(t)).length).toBe(MAX_ATTACHMENTS_PER_TASK);
  });
});

describe("the HTTP routes", () => {
  const params = (taskId = taskA) => ({ orgId: O.org.id, taskId });
  const path = (suffix = "") => `/api/orgs/${O.org.id}/tasks/${taskA}/attachments${suffix}`;
  const withToken = (token: string | undefined) => setRuntimeForTests({ ...app.runtime, blobToken: token });
  const tokenReq = (cl: Client, pathname: string, extra: Record<string, unknown> = {}) =>
    cl.route(tokenRoute as never, "POST", path("/direct"), { type: "blob.generate-client-token", payload: { pathname, clientPayload: null, multipart: false, ...extra } }, params());

  it("issues a client token that is bound to one name, the size limit, a generic type, no overwrite and no callback", async () => {
    withToken(FAKE_BLOB_TOKEN);
    const pathname = keyFor();
    const before = Date.now();
    const res = await tokenReq(web.client, pathname);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; clientToken: string };
    expect(body.type).toBe("blob.generate-client-token");
    const payload = getPayloadFromClientToken(body.clientToken) as unknown as Record<string, unknown>;
    expect(payload).toMatchObject({ pathname, maximumSizeInBytes: MAX_DIRECT_UPLOAD_BYTES, allowedContentTypes: ["application/octet-stream"], addRandomSuffix: false, allowOverwrite: false });
    expect(payload.onUploadCompleted).toBeUndefined();
    expect(payload.validUntil as number).toBeGreaterThan(before + 5 * 60_000);
    expect(payload.validUntil as number).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1000);
    expect(body.clientToken).not.toContain(FAKE_BLOB_TOKEN);
  });

  it("refuses everything it should", async () => {
    withToken(FAKE_BLOB_TOKEN);
    const good = keyFor();
    expect((await tokenReq(new Client(app.auth), good)).status).toBe(401);
    expect((await tokenReq(web.client, keyFor(taskB))).status).toBe(422); // a name for another task
    expect((await tokenReq(web.client, `orgs/${X.org.id}/tasks/${taskA}/${randomUUID()}`)).status).toBe(422);
    expect((await tokenReq(web.client, `orgs/${O.org.id.toUpperCase()}/tasks/${taskA}/${randomUUID()}`)).status).toBe(422); // same org, different spelling
    const other = new Request(`http://localhost:3000${path("/direct")}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", cookie: [...web.client.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname: good } }) });
    expect((await tokenRoute(other, { params: Promise.resolve(params()) } as never)).status).toBe(403); // CSRF
    // the completion callback type is not accepted here, and neither are extra fields
    expect((await web.client.route(tokenRoute as never, "POST", path("/direct"), { type: "blob.upload-completed", payload: {} }, params())).status).toBe(422);
    expect((await tokenReq(web.client, good, { extra: 1 })).status).toBe(422);
    // a viewer and an outsider
    const viewer = await registerAndSignIn(app, "directviewer");
    const [vrow] = await c.admin.select({ id: users.id }).from(users).where(eq(users.email, viewer.email));
    expect((await tokenReq(viewer.client, good)).status).toBe(404); // not a member: the organization is not disclosed
    await addMember(c.admin, O.org.id, vrow!.id, { role: "viewer" });
    expect((await tokenReq(viewer.client, good)).status).toBe(403);
  });

  it("is switched off when no Blob store is configured, and the page is told what the limits are", async () => {
    withToken(undefined);
    expect((await tokenReq(web.client, keyFor())).status).toBe(409);
    const off = await (await web.client.route(listRoute as never, "GET", path(), undefined, params())).json();
    expect(off.limits).toEqual({ serverMaxBytes: 4_000_000, directMaxBytes: null });
    withToken(FAKE_BLOB_TOKEN);
    const on = await (await web.client.route(listRoute as never, "GET", path(), undefined, params())).json();
    expect(on.limits).toEqual({ serverMaxBytes: 4_000_000, directMaxBytes: MAX_DIRECT_UPLOAD_BYTES });
  });

  it("completes through HTTP, and refuses a name that is not an upload name", async () => {
    withToken(FAKE_BLOB_TOKEN);
    const key = keyFor();
    await arrives(key, pdf(7_000_000));
    const res = await web.client.route(completeRoute as never, "POST", path("/direct/complete"), { key, name: "seven.pdf" }, params());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ filename: "seven.pdf", contentType: "application/pdf", sizeBytes: 7_000_000 });
    expect((await web.client.route(completeRoute as never, "POST", path("/direct/complete"), { key: "../../etc/passwd", name: "a.pdf" }, params())).status).toBe(422);
    expect((await web.client.route(completeRoute as never, "POST", path("/direct/complete"), { key, name: "seven.pdf", more: true }, params())).status).toBe(422);
    withToken(undefined);
  });
});
