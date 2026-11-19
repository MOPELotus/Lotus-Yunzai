import { constants, linkSync, lstatSync, renameSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { mergeStarRailGachaHistory, type StarRailGachaSnapshot } from "./gacha-history.ts";

type AcquireHistoryLock = (file: string, subject: string) => Promise<{ close(): void }>;
type VerifyProfile = () => Promise<void>;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function checkIdentity(qq: string, uid: string): void {
  if (!/^[1-9]\d*$/u.test(qq) || !/^[1-9]\d*$/u.test(uid)) {
    throw new TypeError("星铁抽卡历史的 QQ 或 UID 无效。");
  }
}

async function readSnapshot(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (!handle) return;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("星铁抽卡历史须为普通 JSON 文件。");
    return { info, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

type StoredSnapshot = NonNullable<Awaited<ReturnType<typeof readSnapshot>>>;

function decode(current: StoredSnapshot | undefined): unknown {
  if (!current) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(current.bytes));
  } catch {
    throw new Error("星铁抽卡历史的 JSON 格式无效。");
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
  data: ReturnType<typeof mergeStarRailGachaHistory>["log"],
  verifyProfile: VerifyProfile,
): Promise<void> {
  const staging = await mkdtemp(join(directory, ".lotus-gacha-write-"));
  try {
    const pending = join(staging, "history.json");
    const handle = await open(pending, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
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

    const latest = original && await readSnapshot(file);
    if (original && !unchanged(original, latest)) {
      throw new Error("星铁抽卡历史已变更，请重新更新。");
    }
    await verifyProfile();
    if (latest) {
      const beforeReplace = lstatSync(file, { throwIfNoEntry: false });
      if (!beforeReplace?.isFile() || beforeReplace.ino !== latest.info.ino ||
          beforeReplace.dev !== latest.info.dev || beforeReplace.size !== latest.info.size ||
          beforeReplace.ctimeMs !== latest.info.ctimeMs || beforeReplace.mtimeMs !== latest.info.mtimeMs) {
        throw new Error("星铁抽卡历史已变更，请重新更新。");
      }
      renameSync(pending, file);
    } else {
      linkSync(pending, file);
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createStarRailGachaHistoryStore(directory: string, acquireLock: AcquireHistoryLock) {
  async function locate(qq: string, create: boolean) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const root = await realpath(directory);
      const target = join(root, qq);
      if (create) await mkdir(target, { recursive: true, mode: 0o700 });
      if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) {
        throw new Error("星铁抽卡历史的 QQ 目录须为实际目录。");
      }
      return target;
    } catch (error) {
      if (!missing(error) || create) throw error;
    }
  }

  return {
    async read(qq: string, uid: string): Promise<unknown> {
      checkIdentity(qq, uid);
      const userDirectory = await locate(qq, false);
      return userDirectory ? decode(await readSnapshot(join(userDirectory, `${uid}.json`))) : null;
    },
    async merge(
      identity: { readonly qq: string; readonly profileId: number },
      latest: StarRailGachaSnapshot,
      verifyProfile: VerifyProfile,
    ) {
      checkIdentity(identity.qq, latest.uid);
      await verifyProfile();
      const userDirectory = (await locate(identity.qq, true))!;
      const file = join(userDirectory, `${latest.uid}.json`);
      const lock = await acquireLock(join(userDirectory, `.${latest.uid}.lotus-gacha.sqlite`), "星铁抽卡历史");
      try {
        await verifyProfile();
        const original = await readSnapshot(file);
        const result = mergeStarRailGachaHistory(decode(original), latest, identity, new Date());
        await save(userDirectory, file, original, result.log, verifyProfile);
        return result;
      } finally {
        lock.close();
      }
    },
  };
}
