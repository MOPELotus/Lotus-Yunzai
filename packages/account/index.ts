import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DeviceBinding } from "./device-binding.ts";
import { normalizeProfileRoleArtworkUrl } from "./role-artwork-url.ts";
export { parseDeviceBinding, type DeviceBinding } from "./device-binding.ts";
export { normalizeProfileRoleArtworkUrl } from "./role-artwork-url.ts";
export { loadOfficialArtwork } from "./official-artwork.ts";

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

const profileFilenamePattern = /^(\d+)(?:-([1-9]\d{0,2}))?\.yaml$/u;
const cnCheckinGame = { gs: "genshin", sr: "honkai_sr", zzz: "zzz" } as const satisfies Record<Game, string>;
const cnCheckinKeys = ["genshin", "honkai2", "honkai3rd", "tears_of_themis", "honkai_sr", "zzz", "hna"] as const;

function normalizeProfileTime(time: string) {
  return /^(?:[01]?\d|2[0-3]):[0-5]\d$/u.test(time) ? time.padStart(5, "0") : undefined;
}

function profileSchedule(value: unknown) {
  const raw = record(value);
  const mode = raw.mode === "fixed" || raw.mode === "random" ? raw.mode : "inherit";
  const fixedTime = normalizeProfileTime(text(raw.fixed_time));
  return { mode, fixedTime, allowRandom: raw.allow_random !== false } as const;
}

export type ProfileCheckinSettingsChange =
  | { readonly type: "game"; readonly game: Game; readonly enabled: boolean }
  | { readonly type: "all-games"; readonly enabled: boolean }
  | { readonly type: "notify-enabled"; readonly enabled: boolean }
  | { readonly type: "notify-preference"; readonly prefer: "private" }
  | { readonly type: "notify-preference"; readonly prefer: "group"; readonly groupId?: number }
  | { readonly type: "bind-notify-group"; readonly groupId: number }
  | { readonly type: "schedule"; readonly mode: "inherit" | "random" }
  | { readonly type: "schedule"; readonly mode: "fixed"; readonly time: string };

function invalidCheckinSettings(): never {
  throw new ProfileError("invalid", "自动签到设置无效。");
}

function checkinNotifyFields(change: Extract<ProfileCheckinSettingsChange, { type: "notify-enabled" | "notify-preference" | "bind-notify-group" }>) {
  if (change.type === "notify-enabled") {
    if (typeof change.enabled !== "boolean") invalidCheckinSettings();
    return { enable: change.enabled };
  }
  if (change.type === "notify-preference") {
    if (change.prefer === "private") return { prefer: "private" };
    if (change.prefer !== "group") invalidCheckinSettings();
    if (change.groupId === undefined) return { prefer: "group" };
  }
  const id = change.groupId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) invalidCheckinSettings();
  return { prefer: "group", fallback_groups: [String(id)] };
}

function applyCheckinSettings(document: Record<string, unknown>, change: ProfileCheckinSettingsChange) {
  switch (change?.type) {
    case "game":
    case "all-games": {
      if (typeof change.enabled !== "boolean") invalidCheckinSettings();
      const games = record(document.games);
      const cn = record(games.cn);
      const supported = Object.values(cnCheckinGame);
      let keys: readonly string[];
      if (change.type === "game") {
        if (!Object.hasOwn(cnCheckinGame, change.game)) invalidCheckinSettings();
        keys = [cnCheckinGame[change.game]];
      } else {
        keys = cnCheckinKeys.filter(key => supported.some(game => game === key) || Object.hasOwn(cn, key));
      }
      const updated = { ...cn };
      for (const key of keys) updated[key] = { ...record(cn[key]), checkin: change.enabled };
      return { ...document, games: { ...games, cn: updated } };
    }
    case "notify-enabled":
    case "notify-preference":
    case "bind-notify-group": {
      const profile = record(document.profile);
      return { ...document, profile: { ...profile, notify: { ...record(profile.notify), ...checkinNotifyFields(change) } } };
    }
    case "schedule": {
      const { mode } = change;
      if (mode !== "fixed" && mode !== "inherit" && mode !== "random") invalidCheckinSettings();
      const fixedTime = mode === "fixed" && typeof change.time === "string" ? normalizeProfileTime(change.time) : undefined;
      if (mode === "fixed" && fixedTime === undefined) invalidCheckinSettings();
      return { ...document, schedule: { ...record(document.schedule), mode, fixed_time: fixedTime ?? "" } };
    }
    default:
      invalidCheckinSettings();
  }
}

export interface GameRole {
  readonly uid: string;
  readonly region: string;
  readonly gameBiz: string;
  readonly chosen: boolean;
  readonly nickname: string;
  readonly regionName?: string;
  readonly level?: string | number;
  readonly avatar?: string;
}

export function normalizeGameRoles(value: unknown): GameRole[] {
  if (!Array.isArray(value)) return [];
  const roles = new Map<string, GameRole>();
  for (const item of value) {
    const raw = record(item);
    const uid = accountId(raw.uid) || accountId(raw.game_uid) || accountId(item);
    if (uid && !roles.has(uid)) {
      const avatar = normalizeProfileRoleArtworkUrl(raw.game_head_icon) ?? normalizeProfileRoleArtworkUrl(raw.avatar_url);
      roles.set(uid, {
        uid, region: text(raw.region), gameBiz: text(raw.game_biz),
        chosen: raw.is_chosen === true, nickname: text(raw.nickname),
        ...(text(raw.region_name) ? { regionName: text(raw.region_name) } : {}),
        ...(text(raw.level) ? { level: raw.level as string | number } : {}),
        ...(avatar ? { avatar } : {}),
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

function checkinLabel(state: ReturnType<typeof readIdentity>, value: string, fallback: string) {
  const { cookie, stoken, stokenCookie, ltoken, mid } = state.account;
  const { id, fp } = state.device;
  const secrets = [cookie, stoken, stokenCookie, ltoken, mid, id, fp];
  if (secrets.some(secret => secret && value.includes(secret))) return fallback;
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 80) || fallback;
}

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
    const earlier = new Map(normalizeGameRoles(previous.roles[game]).map((role) => [role.uid, role]));
    catalog[game] = list.map((role) => {
      const existing = earlier.get(role.uid);
      const avatar = role.avatar ?? (existing?.region === role.region ? existing.avatar : undefined);
      return {
        uid: role.uid, game_uid: role.uid, game_biz: role.gameBiz, region: role.region,
        region_name: role.regionName ?? role.region, nickname: role.nickname, level: role.level ?? "",
        is_chosen: role.chosen,
        ...(avatar ? { game_head_icon: avatar } : {}),
      };
    });
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

  async function listSlots() {
    try {
      const files = await readdir(root, { withFileTypes: true });
      return files.flatMap(file => {
        if (!file.isFile()) return [];
        const match = profileFilenamePattern.exec(file.name);
        const qq = match?.[1];
        const profileId = Number(match?.[2] ?? 1);
        if (!qq || profileId > MAX_PROFILE_ID || profileFilename(qq, profileId) !== file.name) return [];
        return [{ qq, profileId }];
      });
    } catch (error) {
      if (record(error).code === "ENOENT") return [];
      throw new ProfileError("invalid", "无法读取档案目录。");
    }
  }

  async function readDocument(qq: string, id: number, path = join(root, profileFilename(qq, id))) {
    try {
      const snapshot = await readFileSnapshot(path);
      const data: unknown = Bun.YAML.parse(snapshot.toString("utf8"));
      return { document: record(data), state: readIdentity(data, qq, id), revision: revisionOf(snapshot) };
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      if (record(error).code === "ENOENT") throw new ProfileError("missing", "档案不存在。");
      throw new ProfileError("invalid", "无法读取档案。");
    }
  }

  async function read(qq: string, id: number) {
    const { state, revision } = await readDocument(qq, id);
    return { ...state, revision };
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

  async function updateCheckinProfile(
    qq: string, id: number, expectedRevision: string,
    change: (document: Record<string, unknown>, state: ReturnType<typeof readIdentity>) => Record<string, unknown>,
  ) {
    const filename = profileFilename(qq, id);
    const directory = await realpath(root).catch((error: unknown) => {
      if (record(error).code === "ENOENT") throw new ProfileError("missing", "档案不存在。");
      throw error;
    });
    const path = join(directory, filename);
    return serializeWrite(path, async () => {
      const { document, state, revision } = await readDocument(qq, id, path);
      if (revision !== expectedRevision) throw changedProfile();
      const updated = change(document, state);
      if (isDeepStrictEqual(document, updated)) return { changed: false, revision };
      const saved = await writeProfileDocument(path, updated, revision);
      return { changed: true, revision: saved };
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
    async saveBoundDevice(qq: string, profileId: number, expected: string, binding: DeviceBinding, signal?: AbortSignal) {
      const filename = profileFilename(qq, profileId);
      const path = join(await realpath(root), filename);
      return serializeWrite(path, async () => {
        signal?.throwIfAborted();
        const snapshot = await readFileSnapshot(path).catch(() => { throw changedProfile(); });
        if (revisionOf(snapshot) !== expected) throw changedProfile();
        const value: unknown = Bun.YAML.parse(snapshot.toString("utf8"));
        if (!readIdentity(value, qq, profileId).summary.loggedIn) {
          throw new ProfileError("login-required", "档案尚未登录。");
        }
        const { id, fp, name, model, androidVersion } = binding;
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(id) || !/^[0-9a-f]{13}$/iu.test(fp)) {
          throw new ProfileError("invalid", "请在同一份设备信息中提供设备 ID 和 FP。");
        }
        const device = { bound: true, generated: false, id, fp, name: name ?? "", model: model ?? "",
          android_version: androidVersion ?? "", updated_at: new Date().toISOString() };
        await writeProfileDocument(path, { ...record(value), device }, expected, signal);
      });
    },
    async summary(qq: string, id = 1): Promise<ProfileSummary> {
      return (await read(qq, id)).summary;
    },
    async describe(qq: string, id = 1) {
      const { document, state } = await readDocument(qq, id);
      const profile = record(document.profile);
      const device = record(document.device);
      const schedule = record(document.schedule);
      const games = record(document.games);
      const cn = record(games.cn);
      const os = record(games.os);
      const community = record(document.mihoyobbs);
      const cloud = record(record(document.cloud_games).cn);
      const aid = state.account.ltuid || state.account.stuid;
      const deviceSecrets = [state.device.id, state.device.fp].filter(Boolean).map((value) => value.toLowerCase());
      const deviceName = [state.device.name, state.device.model].find((value) =>
        value && !deviceSecrets.some((secret) => value.toLowerCase().includes(secret)));
      const dayTime = text(schedule.fixed_time);
      const roles = {
        gs: normalizeGameRoles(state.roles.gs), sr: normalizeGameRoles(state.roles.sr), zzz: normalizeGameRoles(state.roles.zzz),
      };
      const activeRoles = {
        gs: accountId(state.selected.gs), sr: accountId(state.selected.sr), zzz: accountId(state.selected.zzz),
      };
      return {
        ...state.summary,
        nickname: text(record(document.user).nickname).slice(0, 80),
        hasCookie: !!state.account.cookie,
        hasStoken: !!(state.account.stoken || state.account.stokenCookie),
        legacyCookie: !state.summary.loggedIn && hasLegacyGameCookie(state.account),
        passport: aid ? (aid.length > 6 ? `${aid.slice(0, 2)}***${aid.slice(-2)}` : "已绑定") : "未绑定",
        device: {
          name: (deviceName || "").slice(0, 80),
          generated: device.generated === true || (device.bound !== true && Boolean(state.device.id)),
          hasFingerprint: Boolean(state.device.id && state.device.fp),
        },
        schedule: { mode: text(schedule.mode), fixedTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(dayTime) ? dayTime : "" },
        notifications: record(profile.notify).enable !== false,
        gameCheckin: Object.fromEntries(["genshin", "honkai2", "honkai3rd", "tears_of_themis", "honkai_sr", "zzz", "hna"]
          .map((game) => [game, record(cn[game]).checkin === true])),
        communityCheckin: community.enable === true && Array.isArray(community.checkin_list)
          ? community.checkin_list.map(Number).filter(Number.isSafeInteger) : [],
        international: {
          enabled: os.enable === true,
          language: /^[a-z]{2}-[a-z]{2}$/iu.test(text(os.lang)) ? text(os.lang) : "zh-cn",
          hasCookie: Boolean(text(os.cookie)),
        },
        cloud: ["genshin", "zzz"].flatMap((game) => {
          const config = record(cloud[game]);
          return config.enable === true ? [{ game, hasToken: Boolean(text(config.token)) }] : [];
        }),
        roles,
        activeRoles,
        rolesPending: Boolean(text(record(document.account).role_sync_error)),
      };
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
      profileFilename(qq, 1);
      return (await listSlots()).filter(slot => slot.qq === qq).map(slot => slot.profileId).sort((a, b) => a - b);
    },
    async listCheckinProfiles() {
      const targets = [];
      for (const { qq, profileId } of await listSlots()) {
        if (!/^[1-9]\d{0,18}$/u.test(qq)) continue;
        const profile = await readDocument(qq, profileId).catch(() => undefined);
        if (!profile) continue;
        targets.push({
          qq, profileId, enabled: profile.state.summary.enabled, loggedIn: profile.state.summary.loggedIn,
          name: checkinLabel(profile.state, profile.state.summary.name, ""),
          schedule: profileSchedule(profile.document.schedule),
        });
      }
      return targets.sort((left, right) => left.qq.localeCompare(right.qq) || left.profileId - right.profileId);
    },
    async accountContext(qq: string, id = 1) {
      const { account, device, revision } = await readLoggedIn(qq, id);
      return { qq, profileId: id, account, device, revision };
    },
    async checkinSettings(qq: string, id: number) {
      const { document, state, revision } = await readDocument(qq, id);
      const cn = record(record(document.games).cn);
      const community = record(document.mihoyobbs);
      const notify = record(record(document.profile).notify);
      const communityEnabled = community.enable === true && record(community.tasks ?? community).checkin === true;
      const displayName = checkinLabel(state, text(record(document.user).nickname), `QQ ${qq}`);
      const games = Object.fromEntries(cnCheckinKeys.map(key => {
        const game = record(cn[key]);
        const defaultEnabled = key === "genshin" || key === "honkai_sr" || key === "zzz";
        const blacklist = Array.isArray(game.black_list) ? game.black_list.map(accountId).filter(Boolean) : [];
        return [key, { enabled: cn.enable !== false && (game.checkin === undefined ? defaultEnabled : game.checkin === true), blacklist }];
      }));
      const communityForums = communityEnabled && Array.isArray(community.checkin_list)
        ? community.checkin_list.map(accountId).filter(Boolean) : [];
      return {
        revision, enabled: state.summary.enabled, loggedIn: state.summary.loggedIn, displayName, games, communityForums,
        schedule: profileSchedule(document.schedule),
        notify: {
          enabled: notify.enable !== false,
          prefer: notify.prefer === "group" ? "group" as const : "private" as const,
          fallbackGroups: Array.isArray(notify.fallback_groups) ? notify.fallback_groups.map(value => Number(accountId(value)))
            .filter(id => Number.isSafeInteger(id) && id > 0) : [],
        },
      };
    },
    async setCheckinEnabled(qq: string, id: number, expectedRevision: string, enabled: boolean) {
      if (typeof enabled !== "boolean") invalidCheckinSettings();
      const result = await updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (enabled && !state.summary.loggedIn) throw new ProfileError("login-required", "档案尚未登录。");
        return state.summary.enabled === enabled ? document : { ...document, enabled };
      });
      return { enabled, ...result };
    },
    async setProfileCheckinSettings(qq: string, id: number, expectedRevision: string, change: ProfileCheckinSettingsChange) {
      return updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (!state.summary.loggedIn) throw new ProfileError("login-required", "档案尚未登录。");
        return applyCheckinSettings(document, change);
      });
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
    const match = profileFilenamePattern.exec(file.name);
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
