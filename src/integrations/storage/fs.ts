import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeKey, type ObjectStore } from "./index";

/** Filesystem store: local development, tests, and self-hosting on a server with a persistent disk (ATTACHMENTS_DIR). Not for serverless hosting, whose disk is ephemeral. */
export function createFsStore(root: string): ObjectStore {
  const resolve = (key: string) => {
    assertSafeKey(key);
    const full = path.resolve(root, key);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("unsafe storage key");
    return full;
  };
  return {
    async put(key, data) {
      const file = resolve(key);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, data, { flag: "wx", mode: 0o600 });
    },
    async get(key) {
      const file = resolve(key);
      try {
        const buf = await readFile(file);
        const { size } = await stat(file);
        return { size, stream: new Blob([buf]).stream() as ReadableStream<Uint8Array> };
      } catch {
        return null;
      }
    },
    async delete(key) {
      await rm(resolve(key), { force: true });
    },
    async list(prefix) {
      assertSafeKey(prefix.replace(/\/$/, "") || "x");
      const out: { key: string; uploadedAt: Date }[] = [];
      const walk = async (dir: string) => {
        let entries: import("node:fs").Dirent[] = [];
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else out.push({ key: path.relative(root, full).split(path.sep).join("/"), uploadedAt: (await stat(full)).mtime });
        }
      };
      await walk(path.resolve(root, prefix));
      return out;
    },
  };
}
