import { deleteAttachment, openAttachment } from "@/data/attachments";
import { contentDisposition } from "@/domain/files";
import { handle } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; attachmentId: string }> };

export const GET = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const file = await c.tenant(p.orgId, (s) => openAttachment(s, c.rt.store, uuid.parse(p.attachmentId)));
    return new Response(file.stream, {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.size),
        "content-disposition": contentDisposition(file.filename),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, no-store",
      },
    });
  });

export const DELETE = (req: Request, { params }: P) =>
  handle(req, async (c) => { const p = await params; await c.tenant(p.orgId, (s) => deleteAttachment(s, uuid.parse(p.attachmentId))); return { ok: true }; });
