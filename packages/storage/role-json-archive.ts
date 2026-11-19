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

async function readSnapshot(file: string, subject: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (!handle) return;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${subject}须为普通 JSON 文件。`);
    return { info, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

type StoredSnapshot = NonNullable<Awaited<ReturnType<typeof readSnapshot>>>;

function decode(current: StoredSnapshot | undefined, subject: string): unknown {
  if (!current) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(current.bytes));
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
): Promise<void> {
  const encoded = JSON.stringify(data, null, 2);
  if (encoded === undefined) throw new TypeError(`${subject}缺少可保存的 JSON。`);
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

    const latest = original && await readSnapshot(file, subject);
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
  { subject, lockSuffix }: { readonly subject: string; readonly lockSuffix: string },
) {
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
      return userDirectory ? decode(await readSnapshot(join(userDirectory, `${uid}.json`), subject), subject) : null;
    },
    async update<Result>(
      { qq, uid }: { readonly qq: string; readonly uid: string },
      verifyProfile: VerifyProfile,
      prepare: (snapshot: unknown) => { readonly document: unknown; readonly result: Result },
    ) {
      checkIdentity(qq, uid, subject);
      await verifyProfile();
      const userDirectory = (await locate(qq, true))!;
      const file = join(userDirectory, `${uid}.json`);
      const lock = await acquireLock(join(userDirectory, `.${uid}.${lockSuffix}.sqlite`), subject);
      try {
        await verifyProfile();
        const original = await readSnapshot(file, subject);
        const { document, result } = prepare(decode(original, subject));
        await save(userDirectory, file, original, document, verifyProfile, subject);
        return result;
      } finally {
        lock.close();
      }
    },
  };
}
