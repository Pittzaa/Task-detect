import { describe, expect, it } from "vitest";
import { contentDisposition, detectFile, sanitizeFilename } from "@/domain/files";
import { assertSafeKey } from "@/integrations/storage";

const bytes = (...n: number[]) => new Uint8Array(n);
const text = (s: string) => new TextEncoder().encode(s);

describe("file type detection (contents decide, not names or client MIME)", () => {
  it("accepts real PNG/JPEG/GIF/WEBP/PDF", () => {
    expect(detectFile(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), "a.png")?.contentType).toBe("image/png");
    expect(detectFile(bytes(0xff, 0xd8, 0xff, 0xe0, 0), "a.jpeg")?.contentType).toBe("image/jpeg");
    expect(detectFile(text("GIF89a..."), "a.gif")?.contentType).toBe("image/gif");
    expect(detectFile(Uint8Array.from([...text("RIFF"), 0, 0, 0, 0, ...text("WEBPVP8 ")]), "a.webp")?.contentType).toBe("image/webp");
    expect(detectFile(text("%PDF-1.7\n"), "doc.pdf")?.contentType).toBe("application/pdf");
  });
  it("rejects when the extension disagrees with the contents", () => {
    expect(detectFile(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "evil.pdf")).toBeNull();
    expect(detectFile(text("%PDF-1.7"), "x.png")).toBeNull();
  });
  it("rejects executables, scripts, HTML and SVG even when renamed", () => {
    expect(detectFile(text("MZ\x90\x00"), "a.png")).toBeNull();
    expect(detectFile(text("<html><script>alert(1)</script></html>"), "a.html")).toBeNull();
    expect(detectFile(text("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"), "a.svg")).toBeNull();
    expect(detectFile(text("<svg onload=alert(1)>"), "a.txt")).not.toBeNull(); // plain text is served as text/plain, never rendered
    expect(detectFile(text("#!/bin/sh\nrm -rf /"), "run.sh")).toBeNull();
  });
  it("accepts UTF-8 text/CSV, rejects binary masquerading as text", () => {
    expect(detectFile(text("สวัสดี\n"), "note.txt")?.contentType).toBe("text/plain");
    expect(detectFile(text("a,b\n1,2"), "d.csv")?.contentType).toBe("text/csv");
    expect(detectFile(bytes(0, 1, 2, 3), "n.txt")).toBeNull();
    expect(detectFile(bytes(0xff, 0xfe, 0xfd), "n.txt")).toBeNull();
  });
  it("accepts Office packages only when structure and extension agree; plain zips are refused", () => {
    const docx = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...text("[Content_Types].xml word/document.xml")]);
    expect(detectFile(docx, "r.docx")?.ext).toBe("docx");
    expect(detectFile(docx, "r.xlsx")).toBeNull();
    expect(detectFile(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...text("hello")]), "a.zip")).toBeNull();
  });
  it("rejects empty files", () => expect(detectFile(new Uint8Array(), "a.txt")).toBeNull());
});

describe("filenames", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\x\\secret.txt", "secret.txt"],
    ["a\u0000b\nc.txt", "abc.txt"],
    ['we"ird<name>.pdf', "we_ird_name_.pdf"],
    ["   .hidden", "hidden"],
    ["", "file"],
    ["..", "file"],
  ])("sanitizes %j", (input, expected) => expect(sanitizeFilename(input)).toBe(expected));
  it("keeps Thai names and bounds length while preserving the extension", () => {
    expect(sanitizeFilename("รายงานประจำเดือน.pdf")).toBe("รายงานประจำเดือน.pdf");
    const long = sanitizeFilename("x".repeat(500) + ".pdf");
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });
  it("strips bidi override characters used to spoof extensions", () => {
    expect(sanitizeFilename("invoice\u202Efdp.exe")).not.toMatch(/\u202e/);
  });
  it("content-disposition always forces download and encodes non-ASCII", () => {
    const h = contentDisposition('ไฟล์ "a".pdf');
    expect(h.startsWith("attachment;")).toBe(true);
    expect(h).toContain("filename*=UTF-8''");
    expect(h).not.toMatch(/[\r\n]/);
    expect(contentDisposition("x\r\ny.pdf")).not.toMatch(/[\r\n]/);
  });
});

describe("storage keys", () => {
  it("accepts server-generated keys", () => expect(() => assertSafeKey("orgs/1a2b/tasks/3c4d/5e6f")).not.toThrow());
  it.each(["../x", "/abs", "a/../b", "a//b", "a b", "a\\b", "", "a\u0000"])("rejects %j", (k) => expect(() => assertSafeKey(k)).toThrow());
});
