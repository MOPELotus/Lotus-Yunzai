import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const games = ["gs", "sr", "zzz"] as const;
export type Game = typeof games[number];
export const MAX_PROFILE_ID = 255;

export class ProfileError extends Error {
  constructor(readonly code: "missing" | "invalid" | "login-required" | "role-missing", message: string) {
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

interface GameRole {
  readonly uid: string;
  readonly region: string;
  readonly gameBiz: string;
  readonly chosen: boolean;
}

function gameRoles(value: unknown): GameRole[] {
  if (!Array.isArray(value)) return [];
  const roles = new Map<string, GameRole>();
  for (const item of value) {
    const raw = record(item);
    const uid = accountId(raw.uid) || accountId(raw.game_uid) || accountId(item);
    if (uid && !roles.has(uid)) {
      roles.set(uid, { uid, region: text(raw.region), gameBiz: text(raw.game_biz), chosen: raw.is_chosen === true });
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

export function createProfileStore(directory: string | URL = new URL("../../data/users/", import.meta.url)) {
  const root = typeof directory === "string" ? directory : fileURLToPath(directory);

  async function read(qq: string, id: number) {
    const path = join(root, profileFilename(qq, id));
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw new Error();
        return readIdentity(Bun.YAML.parse(await file.readFile("utf8")), qq, id);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      if (record(error).code === "ENOENT") throw new ProfileError("missing", "档案不存在。");
      throw new ProfileError("invalid", "无法读取档案。");
    }
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
    async requestContext(qq: string, id: number, game: Game, uid?: string) {
      if (!games.includes(game)) throw new ProfileError("invalid", "游戏类型无效。");
      const profile = await read(qq, id);
      if (!profile.summary.loggedIn) throw new ProfileError("login-required", "档案尚未登录。");

      const roles = gameRoles(profile.roles[game]);
      const role = uid !== undefined ? roles.find((item) => item.uid === uid)
        : roles.find((item) => item.uid === accountId(profile.selected[game]))
          ?? roles.find((item) => item.chosen) ?? roles[0];
      if (!role) throw new ProfileError("role-missing", "档案没有对应的游戏角色。");

      return { qq, profileId: id, game, role, account: profile.account, device: profile.device };
    },
  };
}

export type ProfileRequestContext = Awaited<ReturnType<ReturnType<typeof createProfileStore>["requestContext"]>>;
