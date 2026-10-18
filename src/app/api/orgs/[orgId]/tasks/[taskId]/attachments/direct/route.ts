import { handleUpload } from "@vercel/blob/client";
import { z } from "zod";
import { authorizeDirectUpload } from "@/data/attachments";
import { MAX_DIRECT_UPLOAD_BYTES } from "@/domain/files";
import { conflict } from "@/lib/errors";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; taskId: string }> };

/** Only the "give me an upload token" message is accepted. The completion callback is deliberately not used (see /direct/complete). */
const body = z.object({
  type: z.literal("blob.generate-client-token"),
  payload: z.object({ pathname: z.string().min(1).max(400), clientPayload: z.string().max(2000).nullable().optional(), multipart: z.boolean().optional() }).strict(),
}).strict();

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

/**
 * Issues a short-lived Vercel Blob client token so the browser can send a large file straight to the store, past the ~4.5 MB
 * request-body limit of a serverless function. The session, permission, rate limit and per-task count are checked HERE; the
 * token is then valid for one exact object name, at most 25 MB, one generic content type, and cannot overwrite anything.
 */
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const token = c.rt.blobToken;
    if (!token) throw conflict("Large uploads are not available on this deployment");
    const parsed = await readJson(req, body);
    const taskId = uuid.parse(p.taskId);
    return handleUpload({
      token,
      request: req,
      body: { type: parsed.type, payload: { pathname: parsed.payload.pathname, clientPayload: parsed.payload.clientPayload ?? null, multipart: parsed.payload.multipart ?? false } },
      onBeforeGenerateToken: async (pathname) => {
        await c.tenant(p.orgId, (s) => authorizeDirectUpload(s, taskId, pathname));
        return {
          maximumSizeInBytes: MAX_DIRECT_UPLOAD_BYTES,
          // The stored object is always opaque bytes: the real type is decided by our own inspection and kept in the database.
          allowedContentTypes: ["application/octet-stream"],
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: Date.now() + TOKEN_LIFETIME_MS,
          tokenPayload: null,
        };
      },
    });
  });
