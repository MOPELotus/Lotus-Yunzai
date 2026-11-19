import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const profileGames = ["gs", "sr", "zzz"] as const;
export type Game = typeof profileGames[number];
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
  readonly regionName?: string;
  readonly level?: string | number;
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
        ...(text(raw.region_name) ? { regionName: text(raw.region_name) } : {}),
        ...(text(raw.level) ? { level: raw.level as string | number } : {}),
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

type ProfileDevice = ReturnType<typeof readIdentity>["device"];
type GameRoles = Readonly<Record<Game, readonly GameRole[]>>;

export interface ProfileLoginSlot {
  readonly qq: string;
  readonly profileId: number;
  readonly revision: string | null;
  readonly device: Readonly<ProfileDevice>;
}

export interface ProfileLoginResult {
  readonly stuid: string;
  readonly stoken: string;
  readonly mid?: string;
  readonly credentials: RefreshedCredentials;
  readonly roles?: GameRoles;
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

function changedProfile(): ProfileError {
  return new ProfileError("changed", "档案已变更，请重新发起请求。");
}

async function writeProfileDocument(path: string, document: unknown, expected: string | null, signal?: AbortSignal) {
  const yaml = Bun.YAML.stringify(document);
  if (typeof yaml !== "string") throw new ProfileError("invalid", "无法写入档案凭据。");
  const temporary = await mkdtemp(join(dirname(path), ".profile-write-"));
  try {
    const staged = join(temporary, "profile.yaml");
    await writeFile(staged, yaml, { mode: 0o600 });
    if (expected === null) {
      signal?.throwIfAborted();
      await link(staged, path).catch((error: unknown) => {
        if (record(error).code === "EEXIST") throw changedProfile();
        throw error;
      });
    } else {
      const current = await readFileSnapshot(path).catch(() => { throw changedProfile(); });
      if (revisionOf(current) !== expected) throw changedProfile();
      signal?.throwIfAborted();
      await rename(staged, path);
    }
    return revisionOf(Buffer.from(yaml));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function rolesForStorage(roles: GameRoles, previous: { roles: Record<string, unknown>; selected: Record<string, unknown> }) {
  const catalog = { ...previous.roles };
  const selected = { ...previous.selected };
  for (const game of profileGames) {
    const list = roles[game];
    catalog[game] = list.map((role) => ({
      uid: role.uid, game_uid: role.uid, game_biz: role.gameBiz, region: role.region,
      region_name: role.regionName ?? role.region, nickname: role.nickname, level: role.level ?? "",
      is_chosen: role.chosen,
    }));
    selected[game] = list.find((role) => role.uid === accountId(selected[game]))?.uid
      ?? list.find((role) => role.chosen)?.uid ?? list[0]?.uid ?? "";
  }
  return { game_roles: catalog, current_uid: selected };
}

function cookieFields(value: string) {
  return value.split(";").flatMap((field) => {
    const index = field.indexOf("=");
    return index > 0 ? [[field.slice(0, index).trim(), field.slice(index + 1).trim()] as const] : [];
  });
}

const cookieIdFields = new Set(["stuid", "uid", "ltuid", "ltuid_v2", "account_id", "account_id_v2"]);
const cookieMidFields = new Set(["mid", "stmid_v2", "ltmid_v2", "account_mid_v2"]);

function loginFields(result: ProfileLoginResult) {
  const { stuid, stoken, mid = "", credentials: { cookie, ltoken, stokenCookie } } = result;
  const safeField = (value: string) => /^[!#-:<-~]+$/u.test(value);
  if (!/^[1-9]\d{0,19}$/u.test(stuid) || !safeField(stoken) || !safeField(ltoken) ||
      (mid && !safeField(mid)) || (stoken.startsWith("v2_") && !mid) ||
      !cookie || !stokenCookie || [cookie, stokenCookie].some((value) => value.length > 16_384 || /[^\x20-\x7E]/u.test(value))) {
    throw new ProfileError("invalid", "确认登录返回的档案凭据无效。");
  }
  const session = cookieFields(cookie);
  const login = cookieFields(stokenCookie);
  const fields = [...session, ...login];
  const identities = fields.filter(([key]) => cookieIdFields.has(key));
  if (!identities.length || identities.some(([, value]) => value !== stuid) ||
      fields.some(([key, value]) => cookieMidFields.has(key) && value !== mid) ||
      !session.some(([key, value]) => /^cookie_token(?:_v2)?$/u.test(key) && safeField(value)) ||
      !session.some(([key, value]) => /^ltoken(?:_v2)?$/u.test(key) && value === ltoken) ||
      !login.some(([key, value]) => key === "stoken" && value === stoken) ||
      login.some(([key, value]) => key === "stoken" && value !== stoken)) {
    throw new ProfileError("invalid", "确认登录返回的档案账号不一致。");
  }
  return { ltuid: stuid, stuid, stoken, ltoken, mid, cookie, stoken_cookie: stokenCookie };
}

function matchesStoredLogin(account: ReturnType<typeof readIdentity>["account"], stuid: string) {
  const fields = [...cookieFields(account.cookie), ...cookieFields(account.stokenCookie)];
  const ids = [account.stuid, account.ltuid, ...fields.filter(([key]) => cookieIdFields.has(key)).map(([, value]) => value)].filter(Boolean);
  return ids.length > 0 && ids.every((value) => value === stuid);
}

function hasLegacyGameCookie(account: ReturnType<typeof readIdentity>["account"]): boolean {
  const { cookie } = account;
  if (!cookie || cookie.length > 16_384 || /[^\x20-\x7E]/u.test(cookie)) return false;
  const fields = cookieFields(cookie);
  const unique = (keys: ReadonlySet<string>) => new Set(fields.filter(([key]) => keys.has(key)).map(([, value]) => value));
  const ids = unique(new Set([...cookieIdFields, "login_uid"]));
  const [id] = ids;
  if (ids.size !== 1 || !id || !/^[1-9]\d{0,19}$/u.test(id) ||
      [account.ltuid, account.stuid].some((value) => value && value !== id)) return false;
  const tokenKeys = new Set(["ltoken", "ltoken_v2", "cookie_token", "cookie_token_v2"]);
  const tokens = new Map<string, string>();
  for (const [key, value] of fields) {
    if (!tokenKeys.has(key)) continue;
    if (!/^[!#-:<-~]+$/u.test(value) || (tokens.has(key) && tokens.get(key) !== value)) return false;
    tokens.set(key, value);
  }
  if ((!tokens.has("ltoken") && !tokens.has("ltoken_v2")) ||
      (!tokens.has("cookie_token") && !tokens.has("cookie_token_v2"))) return false;
  const mids = unique(cookieMidFields);
  if (account.mid) mids.add(account.mid);
  const [mid] = mids;
  return mids.size <= 1 && (![...tokens.keys()].some((key) => key.endsWith("_v2")) ||
    (!!mid && /^[!#-:<-~]+$/u.test(mid)));
}

export function createProfileStore(directory: string | URL = new URL("../../data/users/", import.meta.url)) {
  const root = typeof directory === "string" ? directory : fileURLToPath(directory);
  const loginSlots = new WeakSet<ProfileLoginSlot>();

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

  function requestFor(profile: Awaited<ReturnType<typeof readLoggedIn>>, qq: string, profileId: number,
    game: Game, role: GameRole) {
    return { qq, profileId, game, role, account: profile.account, device: profile.device, revision: profile.revision };
  }

  function requestsFor(profile: Awaited<ReturnType<typeof read>>, qq: string, id: number, games: readonly Game[]) {
    return [...new Set(games)].flatMap((game) =>
      normalizeGameRoles(profile.roles[game]).map((role) => requestFor(profile, qq, id, game, role)));
  }

  async function optionalSnapshot(path: string) {
    return readFileSnapshot(path).catch((error: unknown) => {
      if (record(error).code === "ENOENT") return null;
      throw new ProfileError("invalid", "无法读取扫码登录档案。");
    });
  }

  function slotPath(slot: ProfileLoginSlot) {
    if (!loginSlots.has(slot)) throw changedProfile();
    return profileFilename(slot.qq, slot.profileId);
  }

  async function slotSnapshot(path: string, slot: ProfileLoginSlot) {
    const data = await optionalSnapshot(path);
    if ((data && revisionOf(data)) !== slot.revision) throw changedProfile();
    return data;
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
      if (expected !== undefined && expected !== revision) throw changedProfile();
      const current: unknown = Bun.YAML.parse(snapshot.toString("utf8"));
      const state = readIdentity(current, qq, id);
      const data = record(current);
      const updated = { ...data, account: change(record(data.account), state) };
      const latest = readIdentity(updated, qq, id);
      const saved = await writeProfileDocument(path, updated, revision);
      return { qq, profileId: id, account: latest.account, device: latest.device, revision: saved };
    });
  }

  return {
    async openLoginSlot(qq: string, profileId = 1): Promise<ProfileLoginSlot> {
      const filename = profileFilename(qq, profileId);
      const snapshot = await optionalSnapshot(join(root, filename));
      const existing = snapshot ? decodeProfile(snapshot, qq, profileId).device : undefined;
      const device = existing?.id ? existing : {
        id: randomUUID().replaceAll("-", "").toUpperCase(), fp: "", model: existing?.model || "Lotus",
        name: existing?.name || "Lotus Device", androidVersion: existing?.androidVersion || "11", raw: existing?.raw ?? {},
      };
      const slot = Object.freeze({ qq, profileId, revision: snapshot ? revisionOf(snapshot) : null, device: Object.freeze(device) });
      loginSlots.add(slot);
      return slot;
    },
    async verifyLoginSlot(slot: ProfileLoginSlot) {
      await slotSnapshot(join(root, slotPath(slot)), slot);
    },
    async saveLogin(slot: ProfileLoginSlot, result: ProfileLoginResult, signal?: AbortSignal) {
      const filename = slotPath(slot);
      const { qq, profileId, device } = slot;
      const account = loginFields(result);
      signal?.throwIfAborted();
      await mkdir(root, { recursive: true, mode: 0o700 });
      const path = join(await realpath(root), filename);
      return serializeWrite(path, async () => {
        const snapshot = await slotSnapshot(path, slot);
        const initial = { version: 1, enabled: false, user: { qq },
          profile: { id: profileId, name: profileId === 1 ? "default" : `profile-${profileId}` } };
        const original: unknown = snapshot ? Bun.YAML.parse(snapshot.toString("utf8")) : initial;
        const document = record(original);
        const previous = readIdentity(original, qq, profileId);
        const sameAccount = matchesStoredLogin(previous.account, result.stuid);
        const roles = sameAccount ? previous : { roles: {}, selected: {} };
        const emptyRoles = { gs: [], sr: [], zzz: [] } as const;
        const nextRoles = result.roles ? rolesForStorage(result.roles, roles)
          : sameAccount ? { game_roles: previous.roles, current_uid: previous.selected } : rolesForStorage(emptyRoles, roles);
        const now = new Date().toISOString();
        const updated = {
          ...document,
          account: { ...record(document.account), ...account, ...nextRoles, updated_at: now,
            roles_updated_at: result.roles ? now : sameAccount ? text(record(document.account).roles_updated_at) : "",
            role_sync_error: result.roles ? "" : "登录成功，角色暂未同步。" },
          device: previous.device.id ? document.device : {
            ...record(document.device), bound: false, id: device.id, fp: "",
            name: device.name, model: device.model, android_version: device.androidVersion,
          },
        };
        await writeProfileDocument(path, updated, slot.revision, signal);
        loginSlots.delete(slot);
        return { rolesSynced: result.roles !== undefined };
      });
    },
    async summary(qq: string, id = 1): Promise<ProfileSummary> {
      return (await read(qq, id)).summary;
    },
    async savedRole(qq: string, id: number, game: Game): Promise<GameRole> {
      if (!profileGames.includes(game)) throw new ProfileError("invalid", "游戏类型无效。");
      const { roles, selected } = await read(qq, id);
      const list = normalizeGameRoles(roles[game]);
      const uid = accountId(selected[game]);
      const role = uid ? list.find((item) => item.uid === uid) ?? { uid, nickname: "", region: "", gameBiz: "", chosen: false } : list[0];
      if (!role) throw new ProfileError("role-missing", "档案没有对应的游戏角色。");
      return role;
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
    async saveRoles(qq: string, id: number, revision: string, roles: GameRoles) {
      const name = profileFilename(qq, id);
      return updateAccount(qq, id, name, (account, current) => {
        if (!current.summary.loggedIn) throw new ProfileError("login-required", "档案尚未登录。");
        return { ...account, ...rolesForStorage(roles, current),
          roles_updated_at: new Date().toISOString(), role_sync_error: "" };
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
      if (!profileGames.includes(game)) throw new ProfileError("invalid", "游戏类型无效。");
      const profile = await readLoggedIn(qq, id);
      const roles = normalizeGameRoles(profile.roles[game]);
      const role = uid !== undefined ? roles.find((item) => item.uid === uid)
        : roles.find((item) => item.uid === accountId(profile.selected[game]))
          ?? roles.find((item) => item.chosen) ?? roles[0];
      if (!role) throw new ProfileError("role-missing", "档案没有对应的游戏角色。");

      return requestFor(profile, qq, id, game, role);
    },
    async requestContexts(qq: string, id: number, games: readonly Game[] = profileGames) {
      if (games.some((game) => !profileGames.includes(game))) throw new ProfileError("invalid", "游戏类型无效。");
      const profile = await readLoggedIn(qq, id);
      return requestsFor(profile, qq, id, games);
    },
    async requestContextsForRead(qq: string, id: number, games: readonly Game[]) {
      if (games.some((game) => !profileGames.includes(game))) throw new ProfileError("invalid", "游戏类型无效。");
      const profile = await read(qq, id);
      const sources = requestsFor(profile, qq, id, games);
      if (profile.summary.loggedIn) return { sources };
      if (!hasLegacyGameCookie(profile.account)) throw new ProfileError("login-required", "档案尚未登录。");
      return {
        sources,
        async verifyReadOnly() {
          const current = await read(qq, id).catch(() => { throw changedProfile(); });
          if (current.revision !== profile.revision) throw changedProfile();
        },
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
