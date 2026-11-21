import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export class MigrationSourceFileError extends Error {
  constructor(readonly reason: "unsafe" | "changed") {
    super("迁移源文件无法安全读取。");
  }
}

/** Reads a regular snapshot file without following links or accepting changes during the read. */
export async function readMigrationSourceFile(root: string, path: string, maximum: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith(".." + sep) || isAbsolute(local)) {
    throw new MigrationSourceFileError("unsafe");
  }
  const visible = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!visible) return;
  if (!visible.isFile() || visible.nlink !== 1 || visible.size > maximum || await realpath(path) !== path) {
    throw new MigrationSourceFileError("unsafe");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = (info: Stats) => info.dev === visible.dev && info.ino === visible.ino &&
      info.nlink === visible.nlink && info.size === visible.size && info.mtimeMs === visible.mtimeMs && info.ctimeMs === visible.ctimeMs;
    if (!same(await file.stat())) throw new MigrationSourceFileError("changed");
    const bytes = Buffer.alloc(visible.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new MigrationSourceFileError("changed");
      offset += bytesRead;
    }
    if (!same(await file.stat()) || !same(await lstat(path)) || await realpath(path) !== path) {
      throw new MigrationSourceFileError("changed");
    }
    return { bytes, dev: visible.dev, ino: visible.ino };
  } finally {
    await file.close();
  }
}
