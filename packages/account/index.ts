import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("account", messageCatalog.messages);
import { generateProfileDevice } from "./generated-device.ts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { lockFile } from "../../lib/file-lock.ts";
import type { DeviceBinding } from "./device-binding.ts";
import { normalizeProfileRoleArtworkUrl } from "./role-artwork-url.ts";
export { parseDeviceBinding, parseAndroidDeviceInfo, type AndroidDeviceInfo, type DeviceBinding } from "./device-binding.ts";
export { normalizeProfileRoleArtworkUrl } from "./role-artwork-url.ts";
export { loadOfficialArtwork, loadPublicQqAvatar, rasterImageSize } from "./official-artwork.ts";
export { createGroupRankRefresh, type GroupRankRefreshResult } from "./group-rank-refresh.ts";
export { gameRegionDisplayName } from "./region-display.ts";

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
    throw new ProfileError("invalid", $t("index.text_349694e300"));
  }
  return `${qq}${id === 1 ? "" : `-${id}`}.yaml`;
}

const profileFilenamePattern = /^(\d+)(?:-([1-9]\d{0,2}))?\.yaml$/u;
const cnCheckinGame = {
  gs: "genshin", sr: "honkai_sr", zzz: "zzz", nxx: "tears_of_themis", bh3: "honkai3rd", bh2: "honkai2", hna: "hna",
} as const;
type CnCheckinGame = keyof typeof cnCheckinGame;
const cnCheckinKeys = ["genshin", "honkai2", "honkai3rd", "tears_of_themis", "honkai_sr", "zzz", "hna"] as const;
const webCheckinGames = cnCheckinKeys.filter(game => game !== "hna");
type WebCheckinGame = typeof webCheckinGames[number];
const internationalWebGames = ["genshin", "honkai_sr", "zzz", "honkai3rd", "tears_of_themis"] as const;
type InternationalWebGame = typeof internationalWebGames[number];
const defaultCommunityForums = ["1", "2", "3", "4", "5", "6", "8", "9", "10"] as const;

function configuredCnCheckins(cn: Record<string, unknown>) {
  return Object.fromEntries(cnCheckinKeys.map(key => {
    const game = record(cn[key]);
    const defaultEnabled = key === "genshin" || key === "honkai_sr" || key === "zzz";
    const enabled = cn.enable !== false && (game.checkin === undefined ? defaultEnabled : game.checkin === true);
    const blacklist = Array.isArray(game.black_list) ? game.black_list.map(accountId).filter(Boolean) : [];
    return [key, { enabled, blacklist }];
  }));
}

function configuredCommunityForums(community: Record<string, unknown>): string[] {
  if (community.enable !== true || record(community.tasks ?? community).checkin !== true) return [];
  return selectedCommunityForums(community);
}

function selectedCommunityForums(community: Record<string, unknown>): string[] {
  if (community.checkin_list === undefined) return [...defaultCommunityForums];
  if (!Array.isArray(community.checkin_list)) return [];
  const allowed = new Set<string>(defaultCommunityForums);
  return [...new Set(community.checkin_list.map(accountId).filter((id) => allowed.has(id)))];
}

function previewRedeemPreference(value: unknown) {
  const raw = record(value);
  const games = Array.isArray(raw.games) && raw.games.every(game => profileGames.includes(game))
    ? [...new Set<Game>(raw.games)] : value === undefined ? [...profileGames] : [];
  return { enabled: raw.enable === true && games.length > 0, games, allowNewJournal: raw.local_enrollment === true };
}

function profileNotifications(value: unknown) {
  const notify = record(value);
  return {
    enabled: notify.enable !== false,
    prefer: notify.prefer === "group" ? "group" as const : "private" as const,
    fallbackGroups: Array.isArray(notify.fallback_groups) ? notify.fallback_groups.map(value => Number(accountId(value)))
      .filter(id => Number.isSafeInteger(id) && id > 0) : [],
  };
}

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
  | { readonly type: "game"; readonly game: CnCheckinGame; readonly enabled: boolean }
  | { readonly type: "all-games"; readonly enabled: boolean }
  | { readonly type: "community"; readonly enabled: boolean }
  | { readonly type: "international"; readonly enabled: boolean }
  | { readonly type: "international-language"; readonly language: string }
  | { readonly type: "notify-enabled"; readonly enabled: boolean }
  | { readonly type: "notify-preference"; readonly prefer: "private" }
  | { readonly type: "notify-preference"; readonly prefer: "group"; readonly groupId?: number }
  | { readonly type: "bind-notify-group"; readonly groupId: number }
  | { readonly type: "schedule"; readonly mode: "inherit" | "random" }
  | { readonly type: "schedule"; readonly mode: "fixed"; readonly time: string };

interface WebCheckinPreferences {
  readonly enabled: boolean;
  readonly notify: boolean;
  readonly community: boolean;
  readonly games: Readonly<Record<WebCheckinGame, boolean>>;
  readonly forums: readonly number[];
  readonly cloud: Readonly<Record<"genshin" | "zzz", boolean>>;
  readonly osEnabled: boolean;
  readonly os: Readonly<Record<InternationalWebGame, boolean>>;
}

function cloudCredentialPresent(settings: Record<string, unknown>) {
  return typeof settings.token === "string" && settings.token.trim().length > 0;
}

function invalidCheckinSettings(): never {
  throw new ProfileError("invalid", $t("index.text_ec6bfb8c49"));
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
    case "international":
    case "international-language": {
      const games = record(document.games);
      const os = record(games.os);
      if (change.type === "international") {
        if (typeof change.enabled !== "boolean") invalidCheckinSettings();
        return { ...document, games: { ...games, os: { ...os, enable: change.enabled } } };
      }
      if (typeof change.language !== "string" || !/^[A-Za-z_-]{1,32}$/u.test(change.language)) invalidCheckinSettings();
      return { ...document, games: { ...games, os: { ...os, lang: change.language } } };
    }
    case "community": {
      if (typeof change.enabled !== "boolean") invalidCheckinSettings();
      const community = record(document.mihoyobbs);
      if (!change.enabled) return { ...document, mihoyobbs: { ...community, enable: false } };
      const tasks = community.tasks === undefined
        ? Object.fromEntries(["read", "like", "cancel_like", "share"].filter(key => Object.hasOwn(community, key))
          .map(key => [key, community[key]]))
        : record(community.tasks);
      return { ...document, mihoyobbs: { ...community, enable: true, tasks: { ...tasks, checkin: true } } };
    }
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

function updateCloudGame(document: Record<string, unknown>, game: "genshin" | "zzz", fields: Record<string, unknown>) {
  const cloud = record(document.cloud_games);
  const cn = record(cloud.cn);
  return { ...document, cloud_games: { ...cloud, cn: { ...cn, [game]: { ...record(cn[game]), ...fields } } } };
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
    throw new ProfileError("invalid", $t("index.text_38fb3dc7bc"));
  }

  const account = record(data.account);
  const device = record(data.device);
  const raw = record(device.raw);
  const deviceId = text(device.id);
  const cookie = text(account.cookie);
  const stoken = text(account.stoken);
  const stokenCookie = text(account.stoken_cookie);
  const os = record(record(data.games).os);
  const domestic = Boolean(cookie && (stoken || stokenCookie));
  const login = domestic || Boolean(verifiedInternationalAccount(os, os.cookie));
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
    roles: record(!domestic && verifiedInternationalAccount(os, os.cookie) ? os.game_roles : account.game_roles),
    selected: record(!domestic && verifiedInternationalAccount(os, os.cookie) ? os.current_uid : account.current_uid),
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

function fillCheckinNickname(document: Record<string, unknown>, state: ReturnType<typeof readIdentity>, nickname?: string) {
  const user = record(document.user);
  if (typeof nickname !== "string" || text(user.nickname)) return document;
  const name = checkinLabel(state, nickname, "").trim();
  return name ? { ...document, user: { ...user, nickname: name } } : document;
}

async function readFileSnapshot(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error($t("index.text_c7e942deb9"));
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
  readonly nickname?: string;
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
  return new ProfileError("changed", $t("index.text_0b089c48f2"));
}

type ProfileNickname = () => string | undefined;
type OptionalProfileNickname = {
  readonly withoutNickname: Record<string, unknown>;
  readonly changesWithoutNickname: boolean;
  readonly isCurrent: () => boolean;
};

async function writeProfileDocument(path: string, document: unknown, expected: string | null, signal?: AbortSignal,
  verify?: () => Promise<void>, canCommit?: () => boolean, nickname?: OptionalProfileNickname) {
  const yaml = Bun.YAML.stringify(document);
  if (typeof yaml !== "string") throw new ProfileError("invalid", $t("index.text_ccf31274b1"));
  const temporary = await mkdtemp(join(dirname(path), ".profile-write-"));
  try {
    const staged = join(temporary, "profile.yaml");
    await writeFile(staged, yaml, { mode: 0o600 });
    const withoutNickname = nickname?.changesWithoutNickname ? Bun.YAML.stringify(nickname.withoutNickname) : undefined;
    const stagedWithoutNickname = join(temporary, "profile-without-nickname.yaml");
    if (withoutNickname !== undefined) await writeFile(stagedWithoutNickname, withoutNickname, { mode: 0o600 });
    signal?.throwIfAborted();
    // Multiple hosts can share a profile directory. Revision check and publication must share the same OS lock.
    const lock = await lockFile(join(dirname(path), `.${basename(path)}.lotus-profile.sqlite`), $t("index.text_b03d2fbde9"));
    try {
      signal?.throwIfAborted();
      await verify?.();
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
        if (canCommit && !canCommit()) throw new DOMException($t("index.text_ff3070d68b"), "AbortError");
        // A disconnected chat can lose its optional nickname without losing the settings write.
        if (nickname && !nickname.isCurrent()) {
          if (withoutNickname === undefined) return expected;
          await rename(stagedWithoutNickname, path);
          return revisionOf(Buffer.from(withoutNickname));
        }
        await rename(staged, path);
      }
      return revisionOf(Buffer.from(yaml));
    } finally {
      lock.close();
    }
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

function cookieIdentityEvidence(account: ProfileAccountContext["account"]) {
  const fields = [...cookieFields(account.cookie ?? ""), ...cookieFields(account.stokenCookie ?? "")];
  const ids = [account.stuid, account.ltuid,
    ...fields.filter(([key]) => cookieIdFields.has(key) || key === "login_uid").map(([, value]) => value)];
  const mids = [account.mid, ...fields.filter(([key]) => cookieMidFields.has(key)).map(([, value]) => value)];
  return { ids: new Set(ids.filter(Boolean)), conflictingMids: new Set(mids.filter(Boolean)).size > 1 };
}

export function hasConflictingProfileCookieIdentity(account: ProfileAccountContext["account"]): boolean {
  const { ids, conflictingMids } = cookieIdentityEvidence(account);
  return ids.size > 1 || conflictingMids;
}

export function profileCookieAccountId(account: ProfileAccountContext["account"]): string | undefined {
  const { ids, conflictingMids } = cookieIdentityEvidence(account);
  const [id] = ids;
  if (ids.size === 1 && id && /^[1-9]\d{0,19}$/u.test(id) && !conflictingMids) return id;
}

type DeviceBindingSnapshot = Pick<ReturnType<typeof readIdentity>, "account" | "device"> &
  { readonly qq: string; readonly profileId: number; readonly revision: string };

function sameDeviceBindingLogin(before: DeviceBindingSnapshot["account"], after: DeviceBindingSnapshot["account"]) {
  if (isDeepStrictEqual(before, after)) return true;
  const id = profileCookieAccountId(before);
  if (!id || id !== profileCookieAccountId(after)) return false;
  function login(account: DeviceBindingSnapshot["account"]) {
    const stored = new Map(cookieFields(account.stokenCookie));
    const token = account.stoken || stored.get("stoken");
    const mid = account.mid || cookieFields(account.stokenCookie).concat(cookieFields(account.cookie))
      .find(([key]) => cookieMidFields.has(key))?.[1] || "";
    return { token, mid };
  }
  const original = login(before);
  const current = login(after);
  return !!original.token && original.token === current.token && original.mid === current.mid;
}

function loginFields(result: ProfileLoginResult) {
  const { stuid, stoken, mid = "", credentials: { cookie, ltoken, stokenCookie } } = result;
  const safeField = (value: string) => /^[!#-:<-~]+$/u.test(value);
  if (!/^[1-9]\d{0,19}$/u.test(stuid) || !safeField(stoken) || !safeField(ltoken) ||
      (mid && !safeField(mid)) || (stoken.startsWith("v2_") && !mid) ||
      !cookie || !stokenCookie || [cookie, stokenCookie].some((value) => value.length > 16_384 || /[^\x20-\x7E]/u.test(value))) {
    throw new ProfileError("invalid", $t("index.text_7097bd8cc6"));
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
    throw new ProfileError("invalid", $t("index.text_0cdf75fdad"));
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

function verifiedInternationalAccount(os: Record<string, unknown>, credential: unknown) {
  const accountId = text(os.verified_account_id);
  const realm = os.verified_realm;
  if (!/^[1-9]\d{0,19}$/u.test(accountId) || typeof credential !== "string" || !credential ||
      (realm !== "SG" && realm !== "US" && realm !== "EU")) return;
  return { cookie: credential, accountId, realm, language: text(os.lang) || "zh-cn" } as const;
}

function availableProfileRoles(document: Record<string, unknown>, state: ReturnType<typeof readIdentity>, game: Game) {
  const os = record(record(document.games).os);
  const domestic = normalizeGameRoles(record(record(document.account).game_roles)[game]);
  const overseas = verifiedInternationalAccount(os, os.cookie) ? normalizeGameRoles(record(os.game_roles)[game]) : [];
  const unique = new Map([...domestic, ...overseas].map(role => [`${role.gameBiz}:${role.region}:${role.uid}`, role]));
  return unique.size ? [...unique.values()] : normalizeGameRoles(state.roles[game]);
}

export function createProfileStore(directory: string | URL = new URL("../../data/users/", import.meta.url)) {
  const root = typeof directory === "string" ? directory : fileURLToPath(directory);
  const loginSlots = new WeakSet<ProfileLoginSlot>();
  const loginDevices = new WeakMap<ProfileLoginSlot, ReturnType<typeof generateProfileDevice>>();

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
      throw new ProfileError("invalid", $t("index.text_5572903c40"));
    }
  }

  async function readDocument(qq: string, id: number, path = join(root, profileFilename(qq, id))) {
    try {
      const snapshot = await readFileSnapshot(path);
      const data: unknown = Bun.YAML.parse(snapshot.toString("utf8"));
      return { document: record(data), state: readIdentity(data, qq, id), revision: revisionOf(snapshot) };
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      if (record(error).code === "ENOENT") throw new ProfileError("missing", $t("index.text_d4aa366013"));
      throw new ProfileError("invalid", $t("index.text_0ad01bd814"));
    }
  }

  async function read(qq: string, id: number) {
    const { state, revision } = await readDocument(qq, id);
    return { ...state, revision };
  }

  async function readLoggedIn(qq: string, id: number) {
    const profile = await read(qq, id);
    if (!profile.summary.loggedIn || !profile.account.cookie || !(profile.account.stoken || profile.account.stokenCookie)) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
    return profile;
  }

  function requestFor(profile: Awaited<ReturnType<typeof readLoggedIn>>, qq: string, profileId: number,
    game: Game, role: GameRole) {
    return { qq, profileId, game, role, account: profile.account, device: profile.device, revision: profile.revision };
  }

  async function readRoleContext(qq: string, id: number, game: Game, uid: string | undefined, requireSelected: boolean) {
    if (!profileGames.includes(game)) throw new ProfileError("invalid", $t("index.text_eef3f07f3c"));
    const profile = await read(qq, id);
    if (!profile.account.cookie || !(profile.account.stoken || profile.account.stokenCookie)) {
      if (profile.summary.loggedIn) throw new ProfileError("role-missing", $t("index.text_8edebd665e"));
      throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
    }
    const roles = normalizeGameRoles(profile.roles[game]);
    const selection = profile.selected[game];
    const activeUid = uid === undefined ? accountId(selection) : uid;
    if (activeUid && !roles.some(role => role.uid === activeUid)) {
      const { document } = await readDocument(qq, id);
      const os = record(record(document.games).os);
      if (verifiedInternationalAccount(os, os.cookie) && normalizeGameRoles(record(os.game_roles)[game]).some(role => role.uid === activeUid)) {
        throw new ProfileError("role-missing", $t("index.text_8edebd665e"));
      }
    }
    const hasSelection = selection !== undefined && selection !== null && selection !== "";
    const allowFallback = uid === undefined && !(requireSelected && hasSelection);
    const role = roles.find((item) => item.uid === activeUid) ??
      (allowFallback ? roles.find((item) => item.chosen) ?? roles[0] : undefined);
    if (!role) throw new ProfileError("role-missing", $t("index.text_8edebd665e"));
    return requestFor(profile, qq, id, game, role);
  }

  function requestsFor(profile: Awaited<ReturnType<typeof read>>, qq: string, id: number, games: readonly Game[]) {
    return [...new Set(games)].flatMap((game) =>
      normalizeGameRoles(profile.roles[game]).map((role) => requestFor(profile, qq, id, game, role)));
  }

  async function optionalSnapshot(path: string) {
    return readFileSnapshot(path).catch((error: unknown) => {
      if (record(error).code === "ENOENT") return null;
      throw new ProfileError("invalid", $t("index.text_f011fcab3c"));
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
    signal?: AbortSignal, verify?: () => Promise<void>, canCommit?: () => boolean, nickname?: ProfileNickname,
  ) {
    const filename = profileFilename(qq, id);
    const directory = await realpath(root).catch((error: unknown) => {
      if (record(error).code === "ENOENT") throw new ProfileError("missing", $t("index.text_d4aa366013"));
      throw error;
    });
    const path = join(directory, filename);
    return serializeWrite(path, async () => {
      signal?.throwIfAborted();
      const { document, state, revision } = await readDocument(qq, id, path);
      if (revision !== expectedRevision) throw changedProfile();
      const updated = change(document, state);
      const changed = !isDeepStrictEqual(document, updated);
      const displayName = nickname?.();
      const named = fillCheckinNickname(updated, state, displayName);
      if (!changed && named === updated) return { changed: false, revision };
      const optionalNickname = named === updated ? undefined : {
        withoutNickname: updated, changesWithoutNickname: changed,
        isCurrent: () => nickname?.() === displayName,
      };
      const saved = await writeProfileDocument(path, named, revision, signal, verify, canCommit, optionalNickname);
      return { changed: saved !== revision, revision: saved };
    });
  }

  return {
    credentialRefreshScope: () => realpath(root),
    async openLoginSlot(qq: string, profileId = 1): Promise<ProfileLoginSlot> {
      const filename = profileFilename(qq, profileId);
      const snapshot = await optionalSnapshot(join(root, filename));
      const existing = snapshot ? decodeProfile(snapshot, qq, profileId).device : undefined;
      const generated = existing?.id ? undefined : generateProfileDevice();
      const device = generated ? readIdentity({ device: generated }, qq, profileId).device : existing!;
      const slot = Object.freeze({ qq, profileId, revision: snapshot ? revisionOf(snapshot) : null, device: Object.freeze(device) });
      loginSlots.add(slot);
      if (generated) loginDevices.set(slot, generated);
      return slot;
    },
    async verifyLoginSlot(slot: ProfileLoginSlot) {
      await slotSnapshot(join(root, slotPath(slot)), slot);
    },
    async internationalCredentials(qq: string, id: number) {
      const { document, revision } = await readDocument(qq, id);
      const os = record(record(document.games).os);
      const account = verifiedInternationalAccount(os, os.cookie);
      if (!account || !text(os.stoken) || !text(os.mid) || !text(os.device_id)) return;
      return { accountId: account.accountId, realm: account.realm, stoken: text(os.stoken), mid: text(os.mid),
        deviceId: text(os.device_id), revision, refreshedAt: text(os.refreshed_at) };
    },
    async saveInternationalRefreshed(qq: string, id: number, expectedRevision: string, result: {
      readonly cookie: string; readonly activityCookie: string; readonly accountId: string; readonly realm: "SG" | "US" | "EU";
      readonly stoken: string; readonly mid: string; readonly deviceId: string;
    }, signal?: AbortSignal) {
      if (![result.cookie, result.activityCookie].every(value => /^[\x20-\x7e]{1,16384}$/u.test(value))) invalidCheckinSettings();
      return updateCheckinProfile(qq, id, expectedRevision, document => {
        const games = record(document.games), os = record(games.os);
        if (os.verified_account_id !== result.accountId || os.verified_realm !== result.realm || os.stoken !== result.stoken ||
          os.mid !== result.mid || os.device_id !== result.deviceId) throw changedProfile();
        return { ...document, games: { ...games, os: { ...os, cookie: result.cookie,
          verified_activity_cookie: result.activityCookie, refreshed_at: new Date().toISOString() } } };
      }, signal);
    },
    async saveInternationalLogin(slot: ProfileLoginSlot, result: {
      readonly cookie: string; readonly activityCookie: string; readonly accountId: string; readonly realm: "SG" | "US" | "EU";
      readonly stoken: string; readonly mid: string; readonly deviceId: string;
    }, roles: GameRoles, signal?: AbortSignal, groupId?: number) {
      const filename = slotPath(slot);
      if (!/^[1-9]\d{0,19}$/u.test(result.accountId) || !["SG", "US", "EU"].includes(result.realm) ||
        !/^v2_[A-Za-z0-9._~+/%=-]{1,4093}$/u.test(result.stoken) ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(result.mid) || !/^[A-Za-z0-9_-]{1,128}$/u.test(result.deviceId) ||
        ![result.cookie, result.activityCookie].every(value => /^[\x20-\x7e]{1,16384}$/u.test(value)) ||
        groupId !== undefined && (!Number.isSafeInteger(groupId) || groupId < 1)) invalidCheckinSettings();
      await mkdir(root, { recursive: true, mode: 0o700 });
      const path = join(await realpath(root), filename);
      return serializeWrite(path, async () => {
        signal?.throwIfAborted();
        const snapshot = await slotSnapshot(path, slot);
        const document = snapshot ? record(Bun.YAML.parse(snapshot.toString("utf8"))) : {
          version: 1, enabled: false, user: { qq: slot.qq }, profile: { id: slot.profileId, name: slot.profileId === 1 ? "default" : `profile-${slot.profileId}` },
        };
        const games = record(document.games), os = record(games.os);
        const same = os.verified_account_id === result.accountId && os.verified_realm === result.realm;
        const roleState = same ? { roles: record(os.game_roles), selected: record(os.current_uid) } : { roles: {}, selected: {} };
        const storedRoles = rolesForStorage(roles, roleState);
        const profile = record(document.profile), notify = record(profile.notify);
        const groups = Array.isArray(notify.fallback_groups) ? notify.fallback_groups : [];
        const updated = { ...document,
          profile: groupId === undefined || groups.some(value => accountId(value) === String(groupId)) ? profile :
            { ...profile, notify: { ...notify, fallback_groups: [...groups, String(groupId)] } },
          games: { ...games, os: { ...os, enable: true, cookie: result.cookie, verified_activity_cookie: result.activityCookie,
            verified_account_id: result.accountId, verified_realm: result.realm, stoken: result.stoken, mid: result.mid,
            device_id: result.deviceId, refreshed_at: new Date().toISOString(), ...storedRoles,
            ...Object.fromEntries(([['gs', 'genshin'], ['sr', 'honkai_sr'], ['zzz', 'zzz']] as const).map(([key, game]) =>
              [game, { ...record(os[game]), checkin: same && Object.hasOwn(record(os[game]), 'checkin') ? record(os[game]).checkin === true : roles[key].length > 0 }])),
          } },
        };
        // Retain domestic credentials and registration; overseas tokens never enter account.*.
        const revision = await writeProfileDocument(path, updated, slot.revision, signal);
        loginSlots.delete(slot); loginDevices.delete(slot);
        return { revision };
      });
    },
    async checkinAccountContext(qq: string, id = 1) {
      const { account, device, revision, summary } = await read(qq, id);
      if (!summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
      return { qq, profileId: id, account, device, revision };
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
        const savedDevice = record(document.device);
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
            role_sync_error: result.roles ? "" : $t("index.text_4ead3a371d") },
          device: previous.device.id || text(savedDevice.fp) || savedDevice.bound === true ? document.device :
            loginDevices.get(slot) ?? { ...savedDevice, bound: false, id: device.id, fp: "",
              name: device.name, model: device.model, android_version: device.androidVersion, raw: device.raw },
        };
        const nickname = result.nickname && checkinLabel(previous, result.nickname, "");
        const named = nickname ? fillCheckinNickname(updated, readIdentity(updated, qq, profileId), nickname) : updated;
        const revision = await writeProfileDocument(path, named, slot.revision, signal);
        loginSlots.delete(slot);
        loginDevices.delete(slot);
        return { rolesSynced: result.roles !== undefined, revision };
      });
    },
    async prepareGeneratedDevice(qq: string, profileId = 1, signal?: AbortSignal) {
      const path = join(await realpath(root), profileFilename(qq, profileId));
      return serializeWrite(path, async () => {
        signal?.throwIfAborted();
        let { document, state, revision } = await readDocument(qq, profileId, path);
        if (!state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        let device = record(document.device);
        // Migrate only the exact placeholder written by the previous TS login flow.
        // Preserve arbitrary partial legacy identities and every manually bound device.
        const placeholder = /^[A-F0-9]{32}$/u.test(state.device.id) && state.device.model === "Lotus" &&
          state.device.name === "Lotus Device" && Object.keys(state.device.raw).length === 0;
        if (device.bound !== true && !state.device.fp && (!state.device.id || placeholder)) {
          device = generateProfileDevice({ deviceId: state.device.id || undefined });
          document = { ...document, device };
          revision = await writeProfileDocument(path, document, revision, signal);
          state = readIdentity(document, qq, profileId);
        }
        return { source: { qq, profileId, account: state.account, device: state.device, revision },
          pending: device.generated === true && device.bound !== true && Boolean(state.device.id) && !state.device.fp,
          instanceId: text(device.instance_id), deviceGuid: text(record(device.raw).bbsDeviceId) };
      });
    },
    async saveGeneratedDeviceFp(expected: DeviceBindingSnapshot, instanceId: string, fp: string, signal?: AbortSignal) {
      const { qq, profileId } = expected;
      const path = join(await realpath(root), profileFilename(qq, profileId));
      return serializeWrite(path, async () => {
        signal?.throwIfAborted();
        const { document, state, revision } = await readDocument(qq, profileId, path);
        const device = record(document.device);
        if (!state.summary.loggedIn || !sameDeviceBindingLogin(expected.account, state.account) ||
            !isDeepStrictEqual(expected.device, state.device) || device.generated !== true || device.bound === true ||
            !instanceId || text(device.instance_id) !== instanceId || state.device.fp) throw changedProfile();
        if (!/^[0-9a-f]{13}$/iu.test(fp) || ["38d80737ce6f3", "38d7ee834d1e9"].includes(fp.toLowerCase())) {
          throw new ProfileError("invalid", $t("index.text_7fa9ba7fed"));
        }
        await writeProfileDocument(path, { ...document, device: { ...device, fp, fp_source: "mihoyo",
          updated_at: new Date().toISOString() } }, revision, signal);
      });
    },
    async verifyDeviceBindingTarget(qq: string, profileId: number, expected: DeviceBindingSnapshot) {
      const current = await readLoggedIn(qq, profileId).catch(() => { throw changedProfile(); });
      if (expected.qq !== qq || expected.profileId !== profileId ||
          (current.revision !== expected.revision &&
            (!sameDeviceBindingLogin(expected.account, current.account) || !isDeepStrictEqual(expected.device, current.device)))) {
        throw changedProfile();
      }
      if (hasConflictingProfileCookieIdentity(current.account)) throw new ProfileError("invalid", $t("index.text_b639fdff8f"));
    },
    async saveBoundDevice(qq: string, profileId: number, expected: string | DeviceBindingSnapshot, binding: DeviceBinding,
      signal?: AbortSignal) {
      const filename = profileFilename(qq, profileId);
      const path = join(await realpath(root), filename);
      return serializeWrite(path, async () => {
        signal?.throwIfAborted();
        const snapshot = await readFileSnapshot(path).catch(() => { throw changedProfile(); });
        const revision = revisionOf(snapshot);
        const strict = typeof expected === "string";
        if (strict ? revision !== expected : expected.qq !== qq || expected.profileId !== profileId) throw changedProfile();
        const value: unknown = Bun.YAML.parse(snapshot.toString("utf8"));
        const { account, device: previous, summary } = readIdentity(value, qq, profileId);
        if (!strict && revision !== expected.revision &&
            (!sameDeviceBindingLogin(expected.account, account) || !isDeepStrictEqual(expected.device, previous))) throw changedProfile();
        if (!summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        if (hasConflictingProfileCookieIdentity(account)) throw new ProfileError("invalid", $t("index.text_b639fdff8f"));
        const { id, fp, name, model, androidVersion } = binding;
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(id) || !/^[0-9a-f]{13}$/iu.test(fp)) {
          throw new ProfileError("invalid", $t("index.text_806fdd6062"));
        }
        const sameDevice = previous.id === id ? previous : undefined;
        const device = { bound: true, generated: false, id, fp,
          name: name ?? sameDevice?.name ?? "", model: model ?? sameDevice?.model ?? "",
          android_version: androidVersion ?? sameDevice?.androidVersion ?? "", updated_at: new Date().toISOString() };
        await writeProfileDocument(path, { ...record(value), device }, revision, signal);
      });
    },
    async removeBoundDevice(qq: string, profileId: number, expected: string, signal?: AbortSignal) {
      const filename = profileFilename(qq, profileId);
      const path = join(await realpath(root), filename);
      return serializeWrite(path, async () => {
        signal?.throwIfAborted();
        const snapshot = await readFileSnapshot(path).catch(() => { throw changedProfile(); });
        if (revisionOf(snapshot) !== expected) throw changedProfile();
        const value: unknown = Bun.YAML.parse(snapshot.toString("utf8"));
        const { summary } = readIdentity(value, qq, profileId);
        if (!summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        if (!summary.deviceBound) return false;
        await writeProfileDocument(path, { ...record(value), device: { bound: false } }, expected, signal);
        return true;
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
      const domesticLoggedIn = Boolean(state.account.cookie && (state.account.stoken || state.account.stokenCookie));
      const overseasAccount = verifiedInternationalAccount(os, os.cookie);
      const aid = state.account.ltuid || state.account.stuid || overseasAccount?.accountId;
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
        domesticLoggedIn,
        hasCookie: !!state.account.cookie || !!overseasAccount,
        hasStoken: !!(state.account.stoken || state.account.stokenCookie) || !!overseasAccount && !!text(os.stoken),
        legacyCookie: !state.summary.loggedIn && hasLegacyGameCookie(state.account),
        passport: aid ? (aid.length > 6 ? `${aid.slice(0, 2)}***${aid.slice(-2)}` : $t("index.text_f70c0007f3")) : $t("index.text_e026c6693d"),
        device: {
          name: (deviceName || "").slice(0, 80),
          generated: device.generated === true || (device.bound !== true && Boolean(state.device.id)),
          hasFingerprint: Boolean(state.device.id && state.device.fp),
        },
        schedule: { mode: text(schedule.mode), fixedTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(dayTime) ? dayTime : "" },
        notifications: record(profile.notify).enable !== false,
        gameCheckin: Object.fromEntries(Object.entries(configuredCnCheckins(domesticLoggedIn ? cn : { ...cn, enable: false })).map(([game, { enabled }]) => [game, enabled])),
        communityCheckin: configuredCommunityForums(community).map(Number),
        international: {
          enabled: os.enable === true,
          language: /^[A-Za-z_-]{1,32}$/u.test(text(os.lang)) ? text(os.lang) : "zh-cn",
          hasCookie: Boolean(text(os.cookie)),
          roles: { gs: normalizeGameRoles(record(os.game_roles).gs), sr: normalizeGameRoles(record(os.game_roles).sr), zzz: normalizeGameRoles(record(os.game_roles).zzz) },
          activeRoles: { gs: accountId(record(os.current_uid).gs), sr: accountId(record(os.current_uid).sr), zzz: accountId(record(os.current_uid).zzz) },
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
    async roleCatalog(qq: string, id: number) {
      const { document, state, revision } = await readDocument(qq, id);
      const catalog = {
        gs: availableProfileRoles(document, state, "gs"), sr: availableProfileRoles(document, state, "sr"), zzz: availableProfileRoles(document, state, "zzz"),
      };
      const active = { gs: accountId(state.selected.gs), sr: accountId(state.selected.sr), zzz: accountId(state.selected.zzz) };
      return { revision, catalog, active };
    },
    async selectCatalogRole(qq: string, id: number, game: Game, uid: string, expected: string,
      signal: AbortSignal, canCommit: () => boolean) {
      if (!profileGames.includes(game)) throw new ProfileError("invalid", $t("index.text_eef3f07f3c"));
      return updateCheckinProfile(qq, id, expected, (document, state) => {
        if (!canCommit()) throw new DOMException($t("index.text_17a1fdaceb"), "AbortError");
        if (!availableProfileRoles(document, state, game).some(role => role.uid === uid)) {
          throw new ProfileError("role-missing", $t("index.text_2e450055a3"));
        }
        if (accountId(state.selected[game]) === uid) return document;
        const account = record(document.account);
        const games = record(document.games), os = record(games.os);
        const overseas = normalizeGameRoles(record(os.game_roles)[game]).some(role => role.uid === uid);
        if (!state.account.cookie || !(state.account.stoken || state.account.stokenCookie)) {
          return { ...document, games: { ...games, os: { ...os, current_uid: { ...record(os.current_uid), [game]: uid } } } };
        }
        return { ...document, account: { ...account, current_uid: { ...state.selected, [game]: uid } },
          ...(overseas && { games: { ...games, os: { ...os, current_uid: { ...record(os.current_uid), [game]: uid } } } }) };
      }, signal, undefined, canCommit);
    },
    async savedRole(qq: string, id: number, game: Game): Promise<GameRole> {
      if (!profileGames.includes(game)) throw new ProfileError("invalid", $t("index.text_eef3f07f3c"));
      const { document, state } = await readDocument(qq, id);
      const list = availableProfileRoles(document, state, game);
      const uid = accountId(state.selected[game]);
      const role = uid ? list.find((item) => item.uid === uid) ?? { uid, nickname: "", region: "", gameBiz: "", chosen: false } : list[0];
      if (!role) throw new ProfileError("role-missing", $t("index.text_8edebd665e"));
      return role;
    },
    async selectedShopRoleUid(qq: string, id: number, game: "gs" | "sr" | "zzz" | "bh3" | "bh2" | "nxx") {
      const { selected } = await readLoggedIn(qq, id);
      return accountId(selected[game]);
    },
    async listIds(qq: string): Promise<number[]> {
      profileFilename(qq, 1);
      return (await listSlots()).filter(slot => slot.qq === qq).map(slot => slot.profileId).sort((a, b) => a - b);
    },
    async credentialInventory() {
      const users = new Set<string>();
      const domestic = new Set<string>();
      const international = new Set<string>();
      let profiles = 0, legacyProfiles = 0, unreadable = 0;
      for (const { qq, profileId } of await listSlots()) {
        const saved = await readDocument(qq, profileId).catch(() => undefined);
        if (!saved) { unreadable++; continue; }
        users.add(qq);
        profiles++;
        const { document, state: { account, summary } } = saved;
        const aid = profileCookieAccountId(account);
        if (summary.loggedIn && aid) domestic.add(aid);
        if (!summary.loggedIn && hasLegacyGameCookie(account)) legacyProfiles++;
        const os = record(record(document.games).os);
        const overseas = verifiedInternationalAccount(os, os.verified_activity_cookie) ?? verifiedInternationalAccount(os, os.cookie);
        if (overseas) international.add(`${overseas.realm}:${overseas.accountId}`);
      }
      return { users: users.size, profiles, domestic: domestic.size, international: international.size, legacyProfiles, unreadable };
    },
    async listCheckinProfiles(qqs?: ReadonlySet<string>, onlyProfile?: number) {
      const targets = [];
      for (const { qq, profileId } of await listSlots()) {
        if (!/^[1-9]\d{0,18}$/u.test(qq) || (qqs && !qqs.has(qq)) ||
            (onlyProfile !== undefined && profileId !== onlyProfile)) continue;
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
    async listPreviewRedeemProfiles(signal?: AbortSignal) {
      const targets = [];
      for (const { qq, profileId } of await listSlots()) {
        signal?.throwIfAborted();
        if (!/^[1-9][0-9]{0,18}$/u.test(qq)) continue;
        const profile = await readDocument(qq, profileId).catch(() => undefined);
        if (!profile?.state.summary.loggedIn) continue;
        const settings = previewRedeemPreference(profile.document.auto_redeem);
        if (settings.enabled) targets.push({ qq, profileId, games: settings.games, allowNewJournal: settings.allowNewJournal });
      }
      return targets.sort((left, right) => left.qq.localeCompare(right.qq) || left.profileId - right.profileId);
    },
    async previewRedeemSettings(qq: string, profileId: number) {
      const { document, state, revision } = await readDocument(qq, profileId);
      return { ...previewRedeemPreference(document.auto_redeem), revision, loggedIn: state.summary.loggedIn,
        notify: profileNotifications(record(document.profile).notify) };
    },
    async previewRedeemAccount(qq: string, profileId: number, game: Game) {
      if (!profileGames.includes(game)) throw new ProfileError("invalid", $t("index.text_eef3f07f3c"));
      const { document, state, revision } = await readDocument(qq, profileId);
      const settings = previewRedeemPreference(document.auto_redeem);
      if (!state.summary.loggedIn || !settings.enabled || !settings.games.includes(game)) return;
      const raw = state.selected[game];
      const selectedUid = accountId(raw);
      if (raw !== undefined && raw !== null && raw !== "" && !selectedUid) return;
      return { qq, profileId, revision, account: state.account, device: state.device, selectedUid };
    },
    async setPreviewRedeemSettings(qq: string, profileId: number, expectedRevision: string, enabled: boolean,
      games?: readonly Game[], signal?: AbortSignal, verify?: () => Promise<void>,
      options?: { readonly enroll?: true }) {
      if (typeof enabled !== "boolean" || (games && games.some(game => !profileGames.includes(game)))) invalidCheckinSettings();
      if (options?.enroll && !enabled) invalidCheckinSettings();
      return updateCheckinProfile(qq, profileId, expectedRevision, (document, state) => {
        if (enabled && !state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        const previous = previewRedeemPreference(document.auto_redeem);
        const selected = games ? [...new Set(games)] : previous.games;
        if (enabled && !selected.length) throw new ProfileError("invalid", $t("index.text_004c23d73e"));
        if (document.auto_redeem === undefined && !enabled && games === undefined) return document;
        return { ...document, auto_redeem: { ...record(document.auto_redeem), enable: enabled, games: selected,
          ...((document.auto_redeem === undefined || options?.enroll) && { local_enrollment: true }) } };
      }, signal, verify);
    },
    async accountContext(qq: string, id = 1) {
      const { account, device, revision } = await readLoggedIn(qq, id);
      return { qq, profileId: id, account, device, revision };
    },
    async cookieCheckContext(qq: string, id: number) {
      const { account, device, revision, summary } = await read(qq, id);
      const context = { qq, profileId: id, account, device, revision };
      if (hasLegacyGameCookie(account) && profileCookieAccountId(account)) {
        return { kind: summary.loggedIn ? "logged-in" : "read-only", context } as const;
      }
      const kind = account.cookie || account.stoken ? "unverifiable" : "not-logged-in";
      return { kind, context } as const;
    },
    async loginIdentity(qq: string, id: number) {
      const { document, state } = await readDocument(qq, id);
      const { stuid, ltuid, stoken } = state.account;
      const aid = stuid || ltuid;
      if (!state.summary.loggedIn || !aid || (stuid && ltuid && stuid !== ltuid)) {
        throw new ProfileError("login-required", $t("index.text_bda4811c9c"));
      }
      const generation = text(record(document.account).updated_at) || stoken;
      return createHash("sha256").update(JSON.stringify([qq, id, aid, generation])).digest("hex");
    },
    async checkinSettings(qq: string, id: number) {
      const { document, state, revision } = await readDocument(qq, id);
      const cn = record(record(document.games).cn);
      const community = record(document.mihoyobbs);
      const displayName = checkinLabel(state, text(record(document.user).nickname), `QQ ${qq}`);
      const games = configuredCnCheckins(state.account.cookie && (state.account.stoken || state.account.stokenCookie) ? cn : { ...cn, enable: false });
      const communityForums = configuredCommunityForums(community);
      return {
        revision, enabled: state.summary.enabled, loggedIn: state.summary.loggedIn, displayName, games, communityForums,
        schedule: profileSchedule(document.schedule),
        notify: profileNotifications(record(document.profile).notify),
      };
    },
    async webCheckinSettings(qq: string, id: number) {
      const { document, state, revision } = await readDocument(qq, id);
      const games = record(document.games);
      const cn = record(games.cn);
      const os = record(games.os);
      const configured = configuredCnCheckins({ ...cn, enable: true });
      const community = record(document.mihoyobbs);
      const cloud = record(record(document.cloud_games).cn);
      const genshin = record(cloud.genshin);
      const zzz = record(cloud.zzz);
      return {
        enabled: state.summary.enabled,
        notify: profileNotifications(record(document.profile).notify).enabled,
        community: community.enable === true && record(community.tasks ?? community).checkin === true,
        forums: selectedCommunityForums(community).map(Number),
        cloud: { genshin: genshin.enable === true, zzz: zzz.enable === true },
        cloudBound: { genshin: cloudCredentialPresent(genshin), zzz: cloudCredentialPresent(zzz) },
        osEnabled: os.enable === true,
        os: Object.fromEntries(internationalWebGames.map(key => [key, record(os[key]).checkin === true])) as Record<InternationalWebGame, boolean>,
        osBound: /^[1-9][0-9]{0,19}$/u.test(text(os.verified_account_id)) &&
          (os.verified_realm === "SG" || os.verified_realm === "US" || os.verified_realm === "EU") &&
          ((typeof os.cookie === "string" && os.cookie.trim() !== "") ||
           (typeof os.verified_activity_cookie === "string" && os.verified_activity_cookie.trim() !== "")),
        games: Object.fromEntries(webCheckinGames.map(key => [key, configured[key]?.enabled === true])) as Record<WebCheckinGame, boolean>,
        cnEnabled: cn.enable !== false,
        loggedIn: state.summary.loggedIn, revision,
      };
    },
    async setWebCheckinSettings(qq: string, id: number, expectedRevision: string, patch: WebCheckinPreferences,
      signal?: AbortSignal, verify?: () => Promise<void>) {
      if (typeof patch.enabled !== "boolean" || typeof patch.notify !== "boolean" || typeof patch.community !== "boolean") invalidCheckinSettings();
      if (!Array.isArray(patch.forums) || new Set(patch.forums).size !== patch.forums.length ||
          patch.forums.some(id => typeof id !== "number" || !defaultCommunityForums.some(allowed => Number(allowed) === id)) ||
          typeof patch.cloud?.genshin !== "boolean" || typeof patch.cloud?.zzz !== "boolean") invalidCheckinSettings();
      if (typeof patch.osEnabled !== "boolean" || internationalWebGames.some(key => typeof patch.os?.[key] !== "boolean")) invalidCheckinSettings();
      return updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (!state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        const raw = record(record(document.games).cn);
        const configured = configuredCnCheckins({ ...raw, enable: true });
        let updated = state.summary.enabled === patch.enabled ? document : { ...document, enabled: patch.enabled };
        if (patch.notify !== profileNotifications(record(document.profile).notify).enabled) {
          updated = applyCheckinSettings(updated, { type: "notify-enabled", enabled: patch.notify });
        }
        const community = record(document.mihoyobbs);
        const communityEnabled = community.enable === true && record(community.tasks ?? community).checkin === true;
        if (patch.community !== communityEnabled) updated = applyCheckinSettings(updated, { type: "community", enabled: patch.community });
        const previousForums = selectedCommunityForums(community).map(Number);
        if (patch.forums.length !== previousForums.length || patch.forums.some(id => !previousForums.includes(id))) {
          const keep = previousForums.filter(id => patch.forums.includes(id));
          const added = patch.forums.filter(id => !previousForums.includes(id));
          updated = { ...updated, mihoyobbs: { ...record(updated.mihoyobbs), checkin_list: [...keep, ...added] } };
        }
        const cloud = record(record(document.cloud_games).cn);
        for (const game of ["genshin", "zzz"] as const) {
          const previous = record(cloud[game]);
          const enabled = patch.cloud[game];
          if (enabled === (previous.enable === true)) continue;
          if (enabled && !cloudCredentialPresent(previous)) {
            throw new ProfileError("invalid", $t("index.text_70e1c1170d"));
          }
          updated = updateCloudGame(updated, game, { enable: enabled });
        }
        for (const [key, enabled] of Object.entries(patch.games)) {
          if (!webCheckinGames.some(game => game === key) || typeof enabled !== "boolean") invalidCheckinSettings();
          const entry = Object.entries(cnCheckinGame).find(([, name]) => name === key);
          if (entry && configured[key]?.enabled !== enabled) {
            updated = applyCheckinSettings(updated, { type: "game", game: entry[0] as CnCheckinGame, enabled });
          }
        }
        const previousOs = record(record(document.games).os);
        const os = { ...previousOs };
        if (patch.osEnabled !== (previousOs.enable === true)) os.enable = patch.osEnabled;
        for (const game of internationalWebGames) {
          const stored = record(previousOs[game]);
          if (patch.os[game] !== (stored.checkin === true)) os[game] = { ...stored, checkin: patch.os[game] };
        }
        if (!isDeepStrictEqual(previousOs, os)) updated = { ...updated, games: { ...record(updated.games), os } };
        return updated;
      }, signal, verify);
    },
    async internationalRoleContext(qq: string, id: number, game: Game) {
      if (!profileGames.includes(game)) throw new ProfileError("invalid", $t("index.text_eef3f07f3c"));
      const { document, state, revision } = await readDocument(qq, id);
      const os = record(record(document.games).os);
      const account = verifiedInternationalAccount(os, os.verified_activity_cookie);
      if (!state.summary.loggedIn || !account) return;
      return { ...account, revision, selectedUid: accountId(record(os.current_uid)[game]) || accountId(state.selected[game]) };
    },
    async internationalRedeemContext(qq: string, id: number, game: "gs" | "sr") {
      const { document, state, revision } = await readDocument(qq, id);
      const os = record(record(document.games).os);
      const account = verifiedInternationalAccount(os, os.cookie);
      if (!state.summary.loggedIn || !account) return;
      const activity = verifiedInternationalAccount(os, os.verified_activity_cookie);
      return { ...account, revision, selectedUid: accountId(record(os.current_uid)[game]) || accountId(state.selected[game]), activityCookie: activity?.cookie };
    },
    async internationalCheckin(qq: string, id: number, game: "genshin" | "honkai_sr" | "zzz" | "tears_of_themis" | "honkai3rd") {
      const { document, state, revision } = await readDocument(qq, id);
      const os = record(record(document.games).os);
      const setting = record(os[game]);
      if (os.enable !== true || setting.checkin !== true) return { status: "disabled" as const, revision };
      const account = verifiedInternationalAccount(os, game === "genshin" ? os.cookie : os.verified_activity_cookie);
      if (!state.summary.loggedIn || !account) return { status: "unverified" as const, revision };
      return {
        status: "verified", revision, ...account,
        blacklist: Array.isArray(setting.black_list) ? setting.black_list.map(accountId).filter(Boolean) : [],
      } as const;
    },
    async domesticCloudGenshin(qq: string, id: number) {
      const { document, state, revision } = await readDocument(qq, id);
      const { loggedIn } = state.summary;
      const genshin = record(record(record(document.cloud_games).cn).genshin);
      return { loggedIn, revision, token: loggedIn && typeof genshin.token === "string" ? genshin.token.trim() : "" };
    },
    async cloudCheckin(qq: string, id: number) {
      const { document, state, revision } = await readDocument(qq, id);
      const settings = record(document.cloud_games);
      const domestic = record(settings.cn);
      const wallets = domestic.enable === false ? [] : (["genshin", "zzz"] as const).flatMap(game => {
        const { enable, token } = record(domestic[game]);
        return enable === true ? [{ game, token: typeof token === "string" ? token.trim() : "" }] : [];
      });
      const overseas = record(settings.os);
      const genshin = record(overseas.genshin);
      const international = overseas.enable !== false && genshin.enable === true ? [{
        game: "genshin-os" as const, token: text(genshin.token), language: text(overseas.lang) || "zh-cn",
        deviceId: state.device.id, deviceModel: state.device.model, androidVersion: state.device.androidVersion,
      }] : [];
      return { revision, wallets: [...wallets, ...international] };
    },
    async setCheckinEnabled(qq: string, id: number, expectedRevision: string, enabled: boolean,
      signal?: AbortSignal, canCommit?: () => boolean, nickname?: ProfileNickname, groupId?: number) {
      if (typeof enabled !== "boolean") invalidCheckinSettings();
      if (groupId !== undefined && (!Number.isSafeInteger(groupId) || groupId < 1)) invalidCheckinSettings();
      const result = await updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (enabled && !state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        if (enabled && groupId !== undefined) {
          const profile = record(document.profile);
          const notify = record(profile.notify);
          const groups = Array.isArray(notify.fallback_groups) ? notify.fallback_groups : [];
          if (!groups.some((value) => accountId(value) === String(groupId))) {
            return {
              ...document, enabled,
              profile: { ...profile, notify: { ...notify, fallback_groups: [...groups, String(groupId)] } },
            };
          }
        }
        return state.summary.enabled === enabled ? document : { ...document, enabled };
      }, signal, undefined, canCommit, enabled ? nickname : undefined);
      return { enabled, ...result };
    },
    async registerGroupCheckin(qq: string, id: number, expectedRevision: string, groupId: number, nickname?: string) {
      if (!Number.isSafeInteger(groupId) || groupId < 1) invalidCheckinSettings();
      const name = typeof nickname === "string" ? nickname.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 40) : "";
      const { changed, revision } = await updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (!state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        const profile = record(document.profile);
        const notify = record(profile.notify);
        const groups = Array.isArray(notify.fallback_groups) ? notify.fallback_groups as unknown[] : [];
        const present = groups.some(value => accountId(value) === String(groupId));
        if (present && state.summary.enabled) return document;
        const user = record(document.user);
        return {
          ...document, enabled: true,
          ...(name && !text(user.nickname) ? { user: { ...user, nickname: name } } : {}),
          profile: { ...profile, notify: { ...notify, fallback_groups: present ? groups : [...groups, String(groupId)] } },
        };
      });
      return { status: changed ? "updated" as const : "existing" as const, revision };
    },
    async removeGroupCheckinFallback(qq: string, id: number, expectedRevision: string, groupId: number,
      signal: AbortSignal, verify: () => Promise<void>) {
      if (!Number.isSafeInteger(groupId) || groupId < 1) invalidCheckinSettings();
      return updateCheckinProfile(qq, id, expectedRevision, (document) => {
        const profile = record(document.profile);
        const notify = record(profile.notify);
        if (!Array.isArray(notify.fallback_groups)) return document;
        const filtered = notify.fallback_groups.filter(value => Number(accountId(value)) !== groupId);
        if (filtered.length === notify.fallback_groups.length) return document;
        return { ...document, profile: { ...profile, notify: { ...notify, fallback_groups: filtered } } };
      }, signal, verify);
    },
    async setProfileCheckinSettings(qq: string, id: number, expectedRevision: string, change: ProfileCheckinSettingsChange,
      nickname?: ProfileNickname) {
      return updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (!state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        return applyCheckinSettings(document, change);
      }, undefined, undefined, undefined, nickname);
    },
    async saveInternationalCookie(qq: string, id: number, expectedRevision: string,
      verified: { readonly cookie: string; readonly accountId: string; readonly realm: "SG" | "US" | "EU";
        readonly activityCookie?: string },
      signal?: AbortSignal) {
      if (!verified || typeof verified.cookie !== "string" || !/^[\x20-\x7e]{1,16384}$/u.test(verified.cookie) ||
          typeof verified.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(verified.accountId) ||
          (verified.realm !== "SG" && verified.realm !== "US" && verified.realm !== "EU") ||
          (verified.activityCookie !== undefined && (typeof verified.activityCookie !== "string" ||
            !/^[\x20-\x7e]{1,16384}$/u.test(verified.activityCookie)))) invalidCheckinSettings();
      return updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (!state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        const games = record(document.games);
        const { verified_activity_cookie: _previous, stoken, mid, device_id, refreshed_at, ...os } = record(games.os);
        const same = os.verified_account_id === verified.accountId && os.verified_realm === verified.realm;
        return { ...document, games: { ...games, os: {
          ...os, ...(same && { stoken, mid, device_id, refreshed_at }), cookie: verified.cookie, enable: true,
          verified_account_id: verified.accountId, verified_realm: verified.realm,
          ...(verified.activityCookie && { verified_activity_cookie: verified.activityCookie }),
        } } };
      }, signal);
    },
    async setCloudGameEnabled(qq: string, id: number, expectedRevision: string, game: "genshin" | "zzz", enabled: boolean) {
      if ((game !== "genshin" && game !== "zzz") || typeof enabled !== "boolean") invalidCheckinSettings();
      return updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (!state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        return updateCloudGame(document, game, { enable: enabled });
      });
    },
    async saveCloudToken(qq: string, id: number, expectedRevision: string, game: "genshin" | "zzz", token: string, signal?: AbortSignal) {
      if ((game !== "genshin" && game !== "zzz") || typeof token !== "string" || !/^[\x20-\x7e]{1,16384}$/u.test(token)) invalidCheckinSettings();
      return updateCheckinProfile(qq, id, expectedRevision, (document, state) => {
        if (!state.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        return updateCloudGame(document, game, { token, enable: true });
      }, signal);
    },
    // A null catalog means the refresh tried to synchronize roles and failed.
    async saveRefreshedCredentials(qq: string, id: number, revision: string, credentials: RefreshedCredentials, roles?: GameRoles | null) {
      const name = profileFilename(qq, id);
      if (!credentials.cookie.trim() || !credentials.ltoken.trim() ||
          [credentials.cookie, credentials.ltoken, credentials.stokenCookie ?? ""].some((value) => /[\r\n\0]/u.test(value))) {
        throw new ProfileError("invalid", $t("index.text_884478e9a5"));
      }

      return updateAccount(qq, id, name, (account, current) => {
        if (!current.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        if (hasConflictingProfileCookieIdentity({
          ...current.account, cookie: credentials.cookie,
          stokenCookie: credentials.stokenCookie ?? current.account.stokenCookie,
        })) throw new ProfileError("invalid", $t("index.text_5156e890e2"));
        const login = new Map(cookieFields(credentials.stokenCookie ?? ""));
        const stuid = accountId(login.get("stuid"));
        const stoken = current.account.stoken || new Map(cookieFields(current.account.stokenCookie)).get("stoken");
        if (stuid && stoken && login.get("stoken") !== stoken) {
          throw new ProfileError("invalid", $t("index.text_27f8bb597a"));
        }
        return {
          ...account, cookie: credentials.cookie, ltoken: credentials.ltoken,
          ...(stuid && stoken && { stuid, ltuid: stuid, stoken, mid: login.get("mid") ?? current.account.mid }),
          ...(credentials.stokenCookie === undefined ? {} : { stoken_cookie: credentials.stokenCookie }),
          ...(roles && { ...rolesForStorage(roles, current), roles_updated_at: new Date().toISOString(), role_sync_error: "" }),
          ...(roles === null && { role_sync_error: $t("index.text_ac14c9f1f5") }),
        };
      }, revision);
    },
    async saveRoles(qq: string, id: number, revision: string, roles: GameRoles) {
      const name = profileFilename(qq, id);
      return updateAccount(qq, id, name, (account, current) => {
        if (!current.summary.loggedIn) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
        return { ...account, ...rolesForStorage(roles, current),
          roles_updated_at: new Date().toISOString(), role_sync_error: "" };
      }, revision);
    },
    async clearLogin(qq: string, id = 1, current?: { readonly revision: string; readonly signal: AbortSignal;
      readonly canCommit: () => boolean; readonly verify: () => Promise<void> }): Promise<void> {
      const cleared = (account: Record<string, unknown>) => ({
        ...account, ltuid: "", stuid: "", stoken: "", ltoken: "", mid: "", cookie: "",
        stoken_cookie: "", updated_at: "", roles_updated_at: "", role_sync_error: "",
      });
      if (current) {
        await updateCheckinProfile(qq, id, current.revision, document => ({ ...document, account: cleared(record(document.account)), games: { ...record(document.games), os: {} } }),
          current.signal, current.verify, current.canCommit);
      } else {
        const current = await readDocument(qq, id);
        await updateCheckinProfile(qq, id, current.revision, document => ({ ...document,
          account: cleared(record(document.account)), games: { ...record(document.games), os: {} } }));
      }
    },
    requestContext(qq: string, id: number, game: Game, uid?: string) {
      return readRoleContext(qq, id, game, uid, false);
    },
    requestSelectedContext(qq: string, id: number, game: Game) {
      return readRoleContext(qq, id, game, undefined, true);
    },
    async requestContexts(qq: string, id: number, games: readonly Game[] = profileGames) {
      if (games.some((game) => !profileGames.includes(game))) throw new ProfileError("invalid", $t("index.text_eef3f07f3c"));
      const profile = await readLoggedIn(qq, id);
      return requestsFor(profile, qq, id, games);
    },
    async requestContextsForRead(qq: string, id: number, games: readonly Game[]) {
      if (games.some((game) => !profileGames.includes(game))) throw new ProfileError("invalid", $t("index.text_eef3f07f3c"));
      const profile = await read(qq, id);
      const sources = profile.account.cookie ? requestsFor(profile, qq, id, games) : [];
      if (profile.summary.loggedIn && profile.account.cookie && (profile.account.stoken || profile.account.stokenCookie)) return { sources };
      if (!hasLegacyGameCookie(profile.account)) throw new ProfileError("login-required", $t("index.text_ec1c922d00"));
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
  if (from === into) throw new Error($t("index.text_90e1e8d865"));

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

export { forGameCommandSender, gameCommandProfileId, withGameCommandProfiles, type GameCommandProfiles } from "./command-profile.ts";
