import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export function containsPath(directory: string, path: string) {
  const child = relative(directory, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep));
}

export async function publishLegacyJsonExport(parent: string, prefix: "starrail" | "zzz" | "zzz-monthly" | "checkin-schedule", content: Buffer) {
  const hash = createHash("sha256").update(content).digest("hex");
  const path = join(parent, `${prefix}-${hash}.json`);
  const staged = join(parent, `.${prefix}-export-${randomUUID()}.tmp`);
  const handle = await open(staged, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await existing.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 ||
            info.size !== content.length || !(await existing.readFile()).equals(content)) {
          throw new Error("已有导出文件不可复用，请选另一个独立目录。");
        }
      } finally {
        await existing.close();
      }
      return { path, written: false };
    }
    const directory = await open(parent, constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    return { path, written: true };
  } finally {
    await unlink(staged);
  }
}
