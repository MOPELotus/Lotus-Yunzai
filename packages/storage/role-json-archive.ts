import { constants, linkSync, lstatSync, renameSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

export type AcquireRoleArchiveLock = (file: string, subject: string) => Promise<{ close(): void }>;
type VerifyProfile = () => Promise<void>;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function checkIdentity(qq: string, uid: string, subject: string): void {
  if (!/^[1-9]\d*$/u.test(qq) || !/^[1-9]\d*$/u.test(uid)) {
    throw new TypeError(`${subject}的 QQ 或 UID 无效。`);
  }
}

async function readSnapshot(file: string, subject: string, maxBytes?: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (!handle) return;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${subject}须为普通 JSON 文件。`);
    if (maxBytes === undefined) return { info, bytes: await handle.readFile() };
    if (info.size > maxBytes) throw new Error(`${subject}的 JSON 文件过大。`);
    const bytes = Buffer.alloc(info.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error(`${subject}已变更，请重新读取。`);
      offset += bytesRead;
    }
    const latest = await handle.stat();
    if (latest.size !== info.size || latest.ctimeMs !== info.ctimeMs || latest.mtimeMs !== info.mtimeMs) {
      throw new Error(`${subject}已变更，请重新读取。`);
    }
    return { info, bytes };
  } finally {
    await handle.close();
  }
}

type StoredSnapshot = NonNullable<Awaited<ReturnType<typeof readSnapshot>>>;

function decode(current: StoredSnapshot | undefined, subject: string, rejectNull: boolean): unknown {
  if (!current) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(current.bytes));
    if (rejectNull && value === null) throw new TypeError("缺少存档数据。");
    return value;
  } catch {
    throw new Error(`${subject}的 JSON 格式无效。`);
  }
}

function unchanged(original: StoredSnapshot, current: StoredSnapshot | undefined): boolean {
  return current !== undefined && original.info.ino === current.info.ino && original.info.dev === current.info.dev &&
    original.info.mode === current.info.mode && original.info.uid === current.info.uid &&
    original.info.gid === current.info.gid && original.bytes.equals(current.bytes);
}

async function save(
  directory: string,
  file: string,
  original: StoredSnapshot | undefined,
  data: unknown,
  verifyProfile: VerifyProfile,
  subject: string,
  maxBytes?: number,
): Promise<void> {
  const encoded = JSON.stringify(data, null, 2);
  if (encoded === undefined) throw new TypeError(`${subject}缺少可保存的 JSON。`);
  if (maxBytes !== undefined && Buffer.byteLength(encoded, "utf8") + 1 > maxBytes) {
    throw new Error(`${subject}的 JSON 文件过大。`);
  }
  const staging = await mkdtemp(join(directory, ".lotus-gacha-write-"));
  try {
    const pending = join(staging, "history.json");
    const handle = await open(pending, "wx", 0o600);
    try {
      await handle.writeFile(`${encoded}\n`, "utf8");
      if (original) {
        const owner = await handle.stat();
        if (owner.uid !== original.info.uid || owner.gid !== original.info.gid) {
          await handle.chown(original.info.uid, original.info.gid);
        }
        await handle.chmod(original.info.mode & 0o777);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    const latest = original && await readSnapshot(file, subject, maxBytes);
    if (original && !unchanged(original, latest)) {
      throw new Error(`${subject}已变更，请重新更新。`);
    }
    await verifyProfile();
    if (latest) {
      const beforeReplace = lstatSync(file, { throwIfNoEntry: false });
      if (!beforeReplace?.isFile() || beforeReplace.ino !== latest.info.ino ||
          beforeReplace.dev !== latest.info.dev || beforeReplace.size !== latest.info.size ||
          beforeReplace.ctimeMs !== latest.info.ctimeMs || beforeReplace.mtimeMs !== latest.info.mtimeMs) {
        throw new Error(`${subject}已变更，请重新更新。`);
      }
      renameSync(pending, file);
    } else {
      linkSync(pending, file);
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createRoleJsonArchive(
  directory: string,
  acquireLock: AcquireRoleArchiveLock,
  { subject, lockSuffix, maxBytes, rejectNull = false }: {
    readonly subject: string;
    readonly lockSuffix: string;
    readonly maxBytes?: number;
    readonly rejectNull?: boolean;
  },
) {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new RangeError(`${subject}的 JSON 文件大小上限无效。`);
  }
  async function locate(qq: string, create: boolean) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const root = await realpath(directory);
      const target = join(root, qq);
      if (create) await mkdir(target, { recursive: true, mode: 0o700 });
      if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) {
        throw new Error(`${subject}的 QQ 目录须为实际目录。`);
      }
      return target;
    } catch (error) {
      if (!missing(error) || create) throw error;
    }
  }

  return {
    async read(qq: string, uid: string): Promise<unknown> {
      checkIdentity(qq, uid, subject);
      const userDirectory = await locate(qq, false);
      return userDirectory ? decode(await readSnapshot(join(userDirectory, `${uid}.json`), subject, maxBytes), subject, rejectNull) : null;
    },
    async update<Result>(
      { qq, uid }: { readonly qq: string; readonly uid: string },
      verifyProfile: VerifyProfile,
      prepare: (snapshot: unknown) =>
        { readonly document?: unknown; readonly result: Result } | Promise<{ readonly document?: unknown; readonly result: Result }>,
    ) {
      checkIdentity(qq, uid, subject);
      await verifyProfile();
      const userDirectory = (await locate(qq, true))!;
      const file = join(userDirectory, `${uid}.json`);
      const lock = await acquireLock(join(userDirectory, `.${uid}.${lockSuffix}.sqlite`), subject);
      try {
        await verifyProfile();
        const original = await readSnapshot(file, subject, maxBytes);
        const prepared = await prepare(decode(original, subject, rejectNull));
        if ("document" in prepared) {
          if (rejectNull && prepared.document === null) throw new TypeError(`${subject}缺少可保存的数据。`);
          await save(userDirectory, file, original, prepared.document, verifyProfile, subject, maxBytes);
        } else {
          await verifyProfile();
        }
        return prepared.result;
      } finally {
        lock.close();
      }
    },
  };
}
