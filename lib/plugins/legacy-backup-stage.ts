import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, symlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lockFile } from "../file-lock.ts";
import { isManagedPluginDirectory } from "../managed-update-protocol.ts";
import { planMigration, withinInstallation, type LegacyMigrationPlan } from "./migration-plan.ts";

const blockSize = 128 * 1024;
const sourceChanged = () => new Error("旧插件在归档期间发生变化，请重新预检。");
const collision = () => new Error("暂存归档已存在且内容不同。");

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function fileMode(info: Stats) {
  return info.mode & 0o7777;
}

function unchanged(first: Stats, second: Stats) {
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode &&
    first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

async function verifySource(path: string, info: Stats) {
  if (!unchanged(info, await lstat(path))) throw sourceChanged();
}

async function readBlock(handle: FileHandle, buffer: Buffer, length: number, position: number) {
  let count = 0;
  while (count < length) {
    const { bytesRead } = await handle.read(buffer, count, length - count, position + count);
    if (!bytesRead) break;
    count += bytesRead;
  }
  return count;
}

async function transferFile(source: string, destination: string, info: Stats, copy: boolean, signal?: AbortSignal) {
  const readFlags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const input = await open(source, readFlags);
  try {
    if (!unchanged(info, await input.stat())) throw sourceChanged();
    const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const output = await open(destination, copy ? writeFlags : readFlags, 0o600);
    try {
      const before = await output.stat();
      if (!copy && (!before.isFile() || before.size !== info.size || fileMode(before) !== fileMode(info))) throw collision();
      const current = Buffer.allocUnsafe(blockSize);
      const previous = copy ? undefined : Buffer.allocUnsafe(blockSize);
      for (let position = 0; position < info.size;) {
        signal?.throwIfAborted();
        const length = Math.min(blockSize, info.size - position);
        if (await readBlock(input, current, length, position) !== length) throw sourceChanged();
        if (previous) {
          if (await readBlock(output, previous, length, position) !== length ||
              !current.subarray(0, length).equals(previous.subarray(0, length))) throw collision();
        } else {
          let written = 0;
          while (written < length) {
            const { bytesWritten } = await output.write(current, written, length - written, position + written);
            if (!bytesWritten) throw new Error("无法写入插件归档。");
            written += bytesWritten;
          }
        }
        position += length;
      }
      if (!unchanged(info, await input.stat())) throw sourceChanged();
      if (!copy && !unchanged(before, await output.stat())) throw collision();
      if (copy) {
        // A set-id file must not acquire privileges under a different backup owner.
        if ((info.mode & 0o6000) && (before.uid !== info.uid || before.gid !== info.gid)) {
          throw new Error("暂存文件所有者与旧插件的特殊权限不匹配。");
        }
        await output.chmod(fileMode(info));
        await output.sync();
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function transferTree(source: string, destination: string, copy: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const info = await lstat(source);
  const existing = copy ? undefined : await optionalStat(destination);
  if (!copy && (!existing || (info.mode & constants.S_IFMT) !== (existing.mode & constants.S_IFMT) ||
      fileMode(info) !== fileMode(existing))) throw collision();

  if (info.isDirectory()) {
    if (copy) await mkdir(destination, { mode: 0o700 });
    const names = (await readdir(source)).sort();
    if (!copy && !isDeepStrictEqual(names, (await readdir(destination)).sort())) throw collision();
    for (const name of names) {
      await verifySource(source, info);
      await transferTree(join(source, name), join(destination, name), copy, signal);
    }
    if (copy) {
      const folder = await open(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const owner = await folder.stat();
        if ((info.mode & 0o6000) && (owner.uid !== info.uid || owner.gid !== info.gid)) {
          throw new Error("暂存目录所有者与旧插件的特殊权限不匹配。");
        }
        await folder.chmod(fileMode(info));
        await folder.sync();
      } finally {
        await folder.close();
      }
    }
  } else if (info.isSymbolicLink()) {
    // Preserve only the link text. An archive is not an active source tree.
    const target = await readlink(source);
    if (copy) await symlink(target, destination);
    else if (target !== await readlink(destination)) throw collision();
  } else if (info.isFile()) {
    await transferFile(source, destination, info, copy, signal);
  } else {
    throw new Error("旧插件归档含有设备、套接字、管道或其他特殊文件。");
  }
  await verifySource(source, info);
  if (existing && !unchanged(existing, await lstat(destination))) throw collision();
}

async function checkedPath(root: string, path: string, createParents = false) {
  const parts = path.split("/");
  if (parts[0] !== "plugins" || parts.length < 2 || parts.some(part => !isManagedPluginDirectory(part))) {
    throw new Error("插件归档路径无效。");
  }
  let folder = root;
  for (const part of parts.slice(0, -1)) {
    folder = join(folder, part);
    let info = await optionalStat(folder);
    if (!info && createParents) {
      await mkdir(folder, { mode: 0o700 });
      await syncDirectory(dirname(folder));
      info = await lstat(folder);
    }
    if (!info?.isDirectory()) throw new Error("插件归档路径经过非实体目录。");
  }
  return join(root, ...parts);
}

/** The caller owns the disposable staging checkout. This never changes the legacy snapshot or the target checkout. */
export async function stageLegacyPluginBackup(plan: LegacyMigrationPlan, stagingPath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const staging = await realpath(stagingPath);
  const staged = await lstat(staging);
  if (!staged.isDirectory()) throw new Error("插件归档暂存根必须是实体目录。");
  for (const path of [plan.source, plan.target]) {
    const actual = await realpath(path);
    const info = await lstat(actual);
    if (withinInstallation(actual, staging) || withinInstallation(staging, actual) ||
        (info.dev === staged.dev && info.ino === staged.ino)) throw new Error("插件归档暂存根须与新旧安装独立。");
  }
  const confirmPlan = async () => {
    if (!isDeepStrictEqual(plan, await planMigration(plan.source, plan.target))) throw sourceChanged();
  };
  const archive = plan.plugins.filter(entry => entry.status === "archive");
  const lock = await lockFile(join(dirname(staging), `.${basename(staging)}.lotus-plugin-backup.sqlite`), "迁移插件归档");
  let temporary: string | undefined;
  try {
    await confirmPlan();
    if (!archive.length) return { status: "empty", archived: 0 } as const;
    const backup = join(staging, "backup");
    if (!await optionalStat(backup)) {
      await mkdir(backup, { mode: 0o700 });
      await syncDirectory(staging);
    }
    if (!(await lstat(backup)).isDirectory()) throw new Error("暂存 backup 必须为实体目录。");
    const destination = join(backup, "plugins");
    const current = await optionalStat(destination);
    if (current && !current.isDirectory()) throw collision();
    temporary = current ? undefined : await mkdtemp(join(backup, ".lotus-plugins-"));
    for (const { path, kind } of archive) {
      const source = await checkedPath(plan.source, path);
      const input = await lstat(source);
      if (kind === "directory" ? !input.isDirectory() : !input.isFile()) throw sourceChanged();
      const output = await checkedPath(temporary ?? backup, path, temporary !== undefined);
      await transferTree(source, output, temporary !== undefined, signal);
      if (temporary) await syncDirectory(dirname(output));
    }
    if (temporary) {
      for (const { path } of archive) {
        await transferTree(await checkedPath(plan.source, path), await checkedPath(temporary, path), false, signal);
      }
    }
    await confirmPlan();
    signal?.throwIfAborted();
    if (!temporary) return { status: "already-present", archived: archive.length, directory: destination } as const;
    const recorded = join(temporary, "plugins");
    if (await optionalStat(destination)) throw collision();
    await syncDirectory(recorded);
    await rename(recorded, destination);
    await syncDirectory(backup);
    return { status: "published", archived: archive.length, directory: destination } as const;
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      lock.close();
    }
  }
}
