import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MigrationSourceFileError } from "./migration-files.ts";

export const migrationSourceSnapshotVersion = 1;
const archivePath = "backup/migration-source";
type Entry = { path: string; kind: "file"; bytes: number; sha256: string } |
  { path: string; kind: "directory" } |
  { path: string; kind: "symlink"; target: string } |
  { path: string; kind: "special" };

function same(before: Stats, after: Stats) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
    before.nlink === after.nlink && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
}

/** Preserve source config/data independently of the supported active projections. Never follow source links. */
export async function stageMigrationSourceSnapshot(sourcePath: string, stagePath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const source = resolve(sourcePath), stage = resolve(stagePath);
  const [sourceInfo, stageInfo] = await Promise.all([lstat(source), lstat(stage)]);
  if (!sourceInfo.isDirectory() || !stageInfo.isDirectory() || within(source, stage) || within(stage, source) ||
      await realpath(source) !== source || await realpath(stage) !== stage ||
      stageInfo.uid !== process.getuid?.() || stageInfo.mode & 0o077) throw new MigrationSourceFileError("unsafe");
  const backup = join(stage, "backup");
  await mkdir(backup, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(backup)).isDirectory() || await realpath(backup) !== backup) throw new MigrationSourceFileError("unsafe");
  const destination = join(stage, archivePath);
  await mkdir(destination, { mode: 0o700 });
  const entries: Entry[] = [];
  const snapshots = new Map<string, Stats>();
  let bytes = 0, files = 0;
  async function visit(path: string) {
    signal?.throwIfAborted();
    const inputPath = join(source, path), outputPath = join(destination, path);
    const info = await lstat(inputPath);
    snapshots.set(path, info);
    if (info.isSymbolicLink()) {
      // Retain the link description; an absolute link must never point a restored backup at production.
      entries.push({ path, kind: "symlink", target: await readlink(inputPath) });
    } else if (info.isDirectory()) {
      if (await realpath(inputPath) !== inputPath) throw new MigrationSourceFileError("unsafe");
      await mkdir(outputPath, { mode: 0o700 });
      entries.push({ path, kind: "directory" });
      for (const name of (await readdir(inputPath)).sort()) await visit(join(path, name));
    } else if (info.isFile()) {
      if (await realpath(inputPath) !== inputPath) throw new MigrationSourceFileError("unsafe");
      const input = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!same(info, await input.stat())) throw new MigrationSourceFileError("changed");
        const output = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(128 * 1024);
        try {
          for (let offset = 0; offset < info.size;) {
            signal?.throwIfAborted();
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
            if (!bytesRead) throw new MigrationSourceFileError("changed");
            hash.update(buffer.subarray(0, bytesRead));
            for (let written = 0; written < bytesRead;) {
              const result = await output.write(buffer, written, bytesRead - written, offset + written);
              if (!result.bytesWritten) throw new MigrationSourceFileError("changed");
              written += result.bytesWritten;
            }
            offset += bytesRead;
          }
          if (!same(info, await input.stat())) throw new MigrationSourceFileError("changed");
          await output.sync();
        } finally { await output.close(); }
        entries.push({ path, kind: "file", bytes: info.size, sha256: hash.digest("hex") });
        bytes += info.size; files++;
      } finally { await input.close(); }
    } else entries.push({ path, kind: "special" });
    if (!same(info, await lstat(inputPath))) throw new MigrationSourceFileError("changed");
  }
  try {
    for (const scope of ["config", "data"]) {
      const info = await lstat(join(source, scope)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (info) await visit(scope);
    }
    for (const [path, info] of snapshots) {
      signal?.throwIfAborted();
      if (!same(info, await lstat(join(source, path)))) throw new MigrationSourceFileError("changed");
    }
    await writeFile(join(destination, "manifest.json"), JSON.stringify({ version: migrationSourceSnapshotVersion, entries }) + "\n",
      { mode: 0o600, flag: "wx", signal });
    const unresolved = entries.filter(entry => entry.kind === "symlink" || entry.kind === "special")
      .map(entry => ({ path: entry.path, kind: entry.kind }));
    return { version: migrationSourceSnapshotVersion, path: archivePath, files, bytes, unresolved };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
