/**
 * File upload policy. The server decides a file's type from its contents; the client-supplied MIME
 * type and file name are never trusted. SVG, HTML, scripts and archives are deliberately not allowed.
 */
export const MAX_UPLOAD_BYTES = 4_000_000; // stays under Vercel's ~4.5 MB request body limit (verify; see docs)
export const MAX_ATTACHMENTS_PER_TASK = 25;

export interface DetectedFile {
  contentType: string;
  ext: string;
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => Buffer.from(b.subarray(from, to)).toString("latin1");

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

function looksLikeUtf8Text(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Office Open XML files are ZIPs; verify the package really contains the expected top-level part. */
function officeKind(b: Uint8Array): "docx" | "xlsx" | "pptx" | null {
  const text = Buffer.from(b).toString("latin1");
  if (!text.includes("[Content_Types].xml")) return null;
  if (text.includes("word/")) return "docx";
  if (text.includes("xl/")) return "xlsx";
  if (text.includes("ppt/")) return "pptx";
  return null;
}

const OFFICE_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

export function detectFile(bytes: Uint8Array, filename: string): DetectedFile | null {
  if (bytes.length === 0) return null;
  const ext = extOf(filename);
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return ext === "pdf" ? { contentType: "application/pdf", ext } : null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ext === "png" ? { contentType: "image/png", ext } : null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return ext === "jpg" || ext === "jpeg" ? { contentType: "image/jpeg", ext } : null;
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return ext === "gif" ? { contentType: "image/gif", ext } : null;
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return ext === "webp" ? { contentType: "image/webp", ext } : null;
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const kind = officeKind(bytes);
    return kind && ext === kind ? { contentType: OFFICE_TYPES[kind], ext } : null;
  }
  if ((ext === "txt" || ext === "csv" || ext === "md") && looksLikeUtf8Text(bytes)) {
    return { contentType: ext === "csv" ? "text/csv" : ext === "md" ? "text/markdown" : "text/plain", ext };
  }
  return null;
}

/** Display-only name: no path parts, control characters or reserved characters, bounded length. */
export function sanitizeFilename(input: string): string {
  let name = input.normalize("NFC").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!name) return "file";
  if (name.length > 120) {
    const e = extOf(name);
    const base = name.slice(0, name.length - (e ? e.length + 1 : 0));
    name = base.slice(0, 120 - (e ? e.length + 1 : 0)) + (e ? "." + e : "");
  }
  return name;
}

/** RFC 6266 / 5987 header value that forces a download and survives non-ASCII names. */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
