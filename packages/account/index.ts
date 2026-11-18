import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const games = ["gs", "sr", "zzz"] as const;
export type Game = typeof games[number];
export const MAX_PROFILE_ID = 255;

export class ProfileError extends Error {
  constructor(readonly code: "missing" | "invalid" | "login-required" | "role-missing" | "changed", message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

function accountId(value: unknown): string {
  const id = text(value);
  return /^\d+$/u.test(id) ? id : "";
}

function profileFilename(qq: string, id: number): string {
  if (!/^\d+$/u.test(qq) || !Number.isInteger(id) || id < 1 || id > MAX_PROFILE_ID) {
    throw new ProfileError("invalid", "QQ 或档案编号无效。");
  }
  return `${qq}${id === 1 ? "" : `-${id}`}.yaml`;
}

export interface GameRole {
  readonly uid: string;
  readonly region: string;
  readonly gameBiz: string;
  readonly chosen: boolean;
  readonly nickname: string;
}

export function normalizeGameRoles(value: unknown): GameRole[] {
  if (!Array.isArray(value)) return [];
  const roles = new Map<string, GameRole>();
  for (const item of value) {
    const raw = record(item);
    const uid = accountId(raw.uid) || accountId(raw.game_uid) || accountId(item);
    if (uid && !roles.has(uid)) {
      roles.set(uid, {
        uid, region: text(raw.region), gameBiz: text(raw.game_biz),
        chosen: raw.is_chosen === true, nickname: text(raw.nickname),
      });
    }
  }
  return [...roles.values()];
}

function readIdentity(value: unknown, qq: string, id: number) {
  const data = record(value);
  const user = record(data.user);
  const profile = record(data.profile);
  if (data !== value || (data.version !== undefined && text(data.version) !== "1") ||
      (user.qq !== undefined && text(user.qq) !== qq) ||
      (profile.id !== undefined && text(profile.id) !== String(id))) {
    throw new ProfileError("invalid", "档案内容、版本或身份无效。");
  }

  const account = record(data.account);
  const device = record(data.device);
  const raw = record(device.raw);
  const deviceId = text(device.id);
  const cookie = text(account.cookie);
  const stoken = text(account.stoken);
  const stokenCookie = text(account.stoken_cookie);
  const login = Boolean(cookie && (stoken || stokenCookie));
  return {
    summary: { id, name: text(profile.name), enabled: data.enabled === true,
      loggedIn: login, deviceBound: device.bound === true && Boolean(deviceId) },
    account: {
      cookie, stoken, stokenCookie, ltuid: accountId(account.ltuid),
      stuid: accountId(account.stuid), mid: text(account.mid), ltoken: text(account.ltoken),
    },
    device: {
      id: deviceId, fp: deviceId ? text(device.fp) : "", name: text(device.name), model: text(device.model),
      androidVersion: [device.android_version, device.osVersion, device.androidVersion,
        raw.android_version, raw.osVersion, raw.androidVersion].map(text).find(Boolean) ?? "",
      raw,
    },
    roles: record(account.game_roles),
    selected: record(account.current_uid),
  };
}

export type ProfileSummary = Readonly<ReturnType<typeof readIdentity>["summary"]>;

async function readFileSnapshot(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("档案须为普通文件。");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function decodeProfile(buffer: Buffer, qq: string, id: number) {
  return readIdentity(Bun.YAML.parse(buffer.toString("utf8")), qq, id);
}

export interface RefreshedCredentials {
  readonly cookie: string;
  readonly ltoken: string;
  readonly stokenCookie?: string;
}

const writes = new Map<string, Promise<void>>();

function revisionOf(snapshot: Buffer): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

async function serializeWrite<T>(path: string, action: () => Promise<T>): Promise<T> {
  const operation = (writes.get(path) ?? Promise.resolve()).then(action);
  const done = operation.then(() => undefined, () => undefined);
  writes.set(path, done);
  try {
    return await operation;
  } finally {
    if (writes.get(path) === done) writes.delete(path);
  }
}

export function createProfileStore(directory: string | URL = new URL("../../data/users/", import.meta.url)) {
  const root = typeof directory === "string" ? directory : fileURLToPath(directory);

  async function read(qq: string, id: number) {
    const path = join(root, profileFilename(qq, id));
    try {
      const snapshot = await readFileSnapshot(path);
      return { ...decodeProfile(snapshot, qq, id), revision: revisionOf(snapshot) };
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      if (record(error).code === "ENOENT") throw new ProfileError("missing", "档案不存在。");
      throw new ProfileError("invalid", "无法读取档案。");
    }
  }

  async function readLoggedIn(qq: string, id: number) {
    const profile = await read(qq, id);
    if (!profile.summary.loggedIn) throw new ProfileError("login-required", "档案尚未登录。");
    return profile;
  }

  async function updateAccount(
    qq: string,
    id: number,
    name: string,
    change: (account: Record<string, unknown>, current: ReturnType<typeof readIdentity>) => Record<string, unknown>,
    expected?: string,
  ) {
    const directory = await realpath(root);
    const path = join(directory, name);
    return serializeWrite(path, async () => {
      const snapshot = await readFileSnapshot(path);
      const revision = revisionOf(snapshot);
      if (expected !== undefined && expected !== revision) {
        throw new ProfileError("changed", "档案已变更，请重新发起请求。");
      }
      const current: unknown = Bun.YAML.parse(snapshot.toString("utf8"));
      const state = readIdentity(current, qq, id);
      const data = record(current);
      const updated = { ...data, account: change(record(data.account), state) };
      const yaml = Bun.YAML.stringify(updated);
      if (typeof yaml !== "string") throw new ProfileError("invalid", "无法写入档案凭据。");

      const temporary = await mkdtemp(join(directory, ".profile-write-"));
      try {
        const staged = join(temporary, name);
        await writeFile(staged, yaml, { mode: 0o600 });
        if (revisionOf(await readFileSnapshot(path)) !== revision) {
          throw new ProfileError("changed", "档案已变更，请重新发起请求。");
        }
        await rename(staged, path);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      const latest = readIdentity(updated, qq, id);
      return { qq, profileId: id, account: latest.account, device: latest.device, revision: revisionOf(Buffer.from(yaml)) };
    });
  }

  return {
    async summary(qq: string, id = 1): Promise<ProfileSummary> {
      return (await read(qq, id)).summary;
    },
    async listIds(qq: string): Promise<number[]> {
      const base = profileFilename(qq, 1);
      try {
        const files = await readdir(root, { withFileTypes: true });
        const numbered = new RegExp(`^${qq}-([1-9]\\d{0,2})\\.yaml$`, "u");
        return files.flatMap((file) => {
          if (!file.isFile()) return [];
          if (file.name === base) return [1];
          const id = Number(numbered.exec(file.name)?.[1]);
          return id >= 2 && id <= MAX_PROFILE_ID ? [id] : [];
        }).sort((a, b) => a - b);
      } catch (error) {
        if (record(error).code === "ENOENT") return [];
        throw new ProfileError("invalid", "无法读取档案目录。");
      }
    },
    async accountContext(qq: string, id = 1) {
      const { account, device, revision } = await readLoggedIn(qq, id);
      return { qq, profileId: id, account, device, revision };
    },
    async saveRefreshedCredentials(qq: string, id: number, revision: string, credentials: RefreshedCredentials) {
      const name = profileFilename(qq, id);
      if (!credentials.cookie.trim() || !credentials.ltoken.trim() ||
          [credentials.cookie, credentials.ltoken, credentials.stokenCookie ?? ""].some((value) => /[\r\n\0]/u.test(value))) {
        throw new ProfileError("invalid", "刷新响应的凭据格式无效。");
      }

      return updateAccount(qq, id, name, (account, current) => {
        if (!current.summary.loggedIn) throw new ProfileError("login-required", "档案尚未登录。");
        return {
          ...account, cookie: credentials.cookie, ltoken: credentials.ltoken,
          ...(credentials.stokenCookie === undefined ? {} : { stoken_cookie: credentials.stokenCookie }),
        };
      }, revision);
    },
    async clearLogin(qq: string, id = 1): Promise<void> {
      const name = profileFilename(qq, id);
      await updateAccount(qq, id, name, (account) => ({
        ...account, ltuid: "", stuid: "", stoken: "", ltoken: "", mid: "", cookie: "",
        stoken_cookie: "", updated_at: "", roles_updated_at: "", role_sync_error: "",
      }));
    },
    async requestContext(qq: string, id: number, game: Game, uid?: string) {
      if (!games.includes(game)) throw new ProfileError("invalid", "游戏类型无效。");
      const profile = await readLoggedIn(qq, id);
      const roles = normalizeGameRoles(profile.roles[game]);
      const role = uid !== undefined ? roles.find((item) => item.uid === uid)
        : roles.find((item) => item.uid === accountId(profile.selected[game]))
          ?? roles.find((item) => item.chosen) ?? roles[0];
      if (!role) throw new ProfileError("role-missing", "档案没有对应的游戏角色。");

      return {
        qq, profileId: id, game, role, account: profile.account, device: profile.device, revision: profile.revision,
      };
    },
  };
}

export type ProfileRequestContext = Awaited<ReturnType<ReturnType<typeof createProfileStore>["requestContext"]>>;

export type ProfileAccountContext = Awaited<ReturnType<ReturnType<typeof createProfileStore>["accountContext"]>>;

export async function importProfiles(source: string, destination: string, apply = false) {
  const from = await realpath(source);
  const into = await realpath(destination).catch((error: unknown) => {
    if (record(error).code === "ENOENT") return resolve(destination);
    throw error;
  });
  if (from === into) throw new Error("档案导入需要不同的来源和目标目录。");

  const files = await readdir(from, { withFileTypes: true });
  const result = { ready: 0, imported: 0, unchanged: 0, conflict: 0, invalid: 0 };
  if (apply) await mkdir(into, { recursive: true, mode: 0o700 });

  for (const file of files) {
    const match = /^(\d+)(?:-([1-9]\d{0,2}))?\.yaml$/u.exec(file.name);
    const qq = match?.[1];
    if (!qq) continue;
    const id = Number(match?.[2] ?? 1);
    let snapshot: Buffer;
    try {
      if (!file.isFile() || profileFilename(qq, id) !== file.name) throw new Error();
      snapshot = await readFileSnapshot(join(from, file.name));
      decodeProfile(snapshot, qq, id);
    } catch {
      result.invalid++;
      continue;
    }

    const target = join(into, file.name);
    async function existing(): Promise<"unchanged" | "conflict" | undefined> {
      try {
        const bytes = await readFileSnapshot(target);
        return bytes.equals(snapshot) ? "unchanged" : "conflict";
      } catch (error) {
        if (record(error).code === "ENOENT") return;
        if (record(error).code === "ELOOP") return "conflict";
        if (!record(error).code) return "conflict";
        throw error;
      }
    }

    const current = await existing();
    if (current) {
      result[current]++;
      continue;
    }
    if (!apply) {
      result.ready++;
      continue;
    }

    const staging = await mkdtemp(join(into, ".profile-import-"));
    try {
      const staged = join(staging, "profile.yaml");
      await writeFile(staged, snapshot, { mode: 0o600 });
      try {
        await link(staged, target);
        result.imported++;
      } catch (error) {
        if (record(error).code !== "EEXIST") throw error;
        result[(await existing()) ?? "conflict"]++;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return result;
}
