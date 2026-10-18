import { listAttachments, uploadAttachment } from "@/data/attachments";
import { MAX_DIRECT_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from "@/domain/files";
import { validation } from "@/lib/errors";
import { handle } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; taskId: string }> };
export const GET = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    return {
      attachments: await c.tenant(p.orgId, (s) => listAttachments(s, uuid.parse(p.taskId))),
      // what this deployment accepts, so the page can choose between a normal upload and a direct one
      limits: { serverMaxBytes: MAX_UPLOAD_BYTES, directMaxBytes: c.rt.blobToken ? MAX_DIRECT_UPLOAD_BYTES : null },
    };
  });

export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_UPLOAD_BYTES + 100_000) throw validation("File is too large", { maxBytes: MAX_UPLOAD_BYTES });
    let form: FormData;
    try { form = await req.formData(); } catch { throw validation("Expected multipart form data"); }
    const file = form.get("file");
    if (!(file instanceof File)) throw validation("Missing file");
    if (file.size > MAX_UPLOAD_BYTES) throw validation("File is too large", { maxBytes: MAX_UPLOAD_BYTES });
    const bytes = new Uint8Array(await file.arrayBuffer());
    return c.tenant(p.orgId, (s) => uploadAttachment(s, c.rt.store, uuid.parse(p.taskId), { name: file.name, bytes }));
  }, { status: 201 });
