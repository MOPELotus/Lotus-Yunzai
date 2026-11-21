import { createHash, randomInt } from "node:crypto";
import { normalizeProfileRoleArtworkUrl, type ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { GameRecordRequestError, genshinCnRecordRegion } from "./game-record.ts";

interface GrowthTarget {
  readonly id: number;
  readonly level_current: number;
  readonly level_target: number;
}

export interface GenshinBackpackProbeItem {
  readonly avatar_id: number;
  readonly avatar_level_current: number;
  readonly avatar_level_target: number;
  readonly element_attr_id: number;
  readonly skill_list: readonly GrowthTarget[];
  readonly weapon?: GrowthTarget;
}

export interface GenshinBackpackProbe {
  readonly items: readonly GenshinBackpackProbeItem[];
}

export interface GenshinBackpackOptions {
  readonly probe: GenshinBackpackProbe;
  readonly signal?: AbortSignal;
}

export type GenshinGrowthItem =
  | { readonly weapon: GrowthTarget }
  | { readonly avatar_id: number; readonly avatar_level_current: number; readonly avatar_level_target: number;
    readonly skill_list?: readonly GrowthTarget[]; readonly element_attr_id?: number };

export interface GenshinGrowthOptions {
  readonly item: GenshinGrowthItem;
  readonly signal?: AbortSignal;
}

export interface GenshinBackpackItem {
  readonly id: string;
  readonly gameId?: string;
  readonly name: string;
  readonly icon?: string;
  readonly count: number;
  readonly exact: boolean;
}

export interface GenshinBackpackSnapshot {
  readonly uid: string;
  readonly region: "cn_gf01" | "cn_qd01";
  readonly items: readonly GenshinBackpackItem[];
}

export interface GenshinGrowthSnapshot {
  readonly uid: string;
  readonly region: GenshinBackpackSnapshot["region"];
  readonly items: readonly (Pick<GenshinBackpackItem, "id" | "gameId" | "name" | "icon"> &
    { readonly total: number; readonly lack: number })[];
}

type Json = Record<string, unknown>;
type Calculation = "原神背包" | "原神养成计算" | "尘歌壶模数";
type Material = GenshinGrowthSnapshot["items"][number];
const calculator = "https://api-takumi.mihoyo.com/event/e20200928calculate/";
type CalculatorPath = "v3/batch_compute" | "v1/furniture/blueprint" | "v1/furniture/compute";
const maxProbeItems = 128;
const maxResponseItems = 1024;
// The calculator includes per-character upgrade plans alongside the small inventory list.
const maxResponseBytes = 12 * 1024 * 1024;
const appVersion = "2.40.1";
const signingSalt = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function whole(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^-?\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed)) return parsed;
}

function decimalId(value: unknown): string | undefined {
  const id = whole(value);
  if (id !== undefined && id > 0 && (typeof value !== "string" || String(id) === value)) return String(id);
}

function probeError(kind: Calculation = "原神背包"): never {
  throw new HoyoRequestError("invalid-input", kind === "原神背包"
    ? "原神背包的养成计算配方无效。" : "原神养成计算的目标等级或配方无效。");
}

function probeNumber(value: unknown, min: number, max: number, kind?: Calculation): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) probeError(kind);
  return value;
}

function levels(current: unknown, target: unknown, max: number, kind?: Calculation) {
  const level_current = probeNumber(current, 1, max, kind);
  return { level_current, level_target: probeNumber(target, level_current, max, kind) };
}

function growthTarget(value: unknown, maxLevel: number, kind?: Calculation): GrowthTarget {
  const item = object(value);
  if (!item) probeError(kind);
  return { id: probeNumber(item.id, 1, Number.MAX_SAFE_INTEGER, kind), ...levels(item.level_current, item.level_target, maxLevel, kind) };
}

function probeItems(probe: GenshinBackpackProbe): GenshinBackpackProbeItem[] {
  const items = object(probe)?.items;
  if (!Array.isArray(items) || !items.length || items.length > maxProbeItems) probeError();
  return Array.from(items, (input) => {
    const item = object(input);
    if (!item || !Array.isArray(item.skill_list) || item.skill_list.length > 8) probeError();
    const avatar = levels(item.avatar_level_current, item.avatar_level_target, 100);
    return {
      avatar_id: probeNumber(item.avatar_id, 1, Number.MAX_SAFE_INTEGER),
      avatar_level_current: avatar.level_current, avatar_level_target: avatar.level_target,
      element_attr_id: probeNumber(item.element_attr_id, 0, Number.MAX_SAFE_INTEGER),
      skill_list: Array.from(item.skill_list, (skill) => growthTarget(skill, 15)),
      ...(item.weapon === undefined ? {} : { weapon: growthTarget(item.weapon, 100) }),
    };
  });
}

function normalizeGrowthItem(value: GenshinGrowthItem): GenshinGrowthItem {
  const kind = "原神养成计算";
  const item = object(value);
  if (!item) probeError(kind);
  if (item.weapon !== undefined) {
    if (["avatar_id", "avatar_level_current", "avatar_level_target", "skill_list", "element_attr_id"].some(key => key in item)) probeError(kind);
    return { weapon: growthTarget(item.weapon, 90, kind) };
  }
  const avatar = levels(item.avatar_level_current, item.avatar_level_target, 90, kind);
  let skills: GrowthTarget[] | undefined;
  if (item.skill_list !== undefined) {
    if (!Array.isArray(item.skill_list) || item.skill_list.length > 3) probeError(kind);
    skills = Array.from(item.skill_list, row => growthTarget(row, 10, kind));
    if (new Set(skills.map(row => row.id)).size !== skills.length) probeError(kind);
  }
  return {
    avatar_id: probeNumber(item.avatar_id, 1, Number.MAX_SAFE_INTEGER, kind),
    avatar_level_current: avatar.level_current, avatar_level_target: avatar.level_target,
    ...(skills?.length && { skill_list: skills }),
    ...(item.element_attr_id !== undefined && { element_attr_id: probeNumber(item.element_attr_id, 0, Number.MAX_SAFE_INTEGER, kind) }),
  };
}

function requestHeaders(source: ProfileRequestContext, query: string, body: string | undefined, kind: Calculation): Headers {
  const { account, device } = source;
  const cookie = account.cookie.trim();
  const validDeviceField = (value: string | undefined): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
  if (!cookie.includes("=") || /[^\x20-\x7E]/u.test(account.cookie) || cookie.length > 16_384 ||
      !validDeviceField(device.id) || !validDeviceField(device.fp)) {
    throw new HoyoRequestError("invalid-input", `${kind}需要当前档案的 Cookie 和已绑定的设备 ID、指纹。`);
  }
  const time = Math.round(Date.now() / 1000);
  const nonce = randomInt(100000, 1000000);
  const digest = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}&b=${body ?? ""}&q=${query}`).digest("hex");
  const model = device.model && /^[\x20-\x7E]{1,128}$/u.test(device.model) ? device.model : "Android";
  const android = device.androidVersion && /^\d{1,2}(?:\.\d+){0,2}$/u.test(device.androidVersion) ? device.androidVersion : "12";
  return new Headers({
    Accept: "application/json", "Content-Type": "application/json", Cookie: cookie,
    "x-rpc-device_id": device.id, "x-rpc-device_fp": device.fp,
    "x-rpc-app_version": appVersion, "x-rpc-client_type": "5", Referer: "https://webstatic.mihoyo.com/",
    "User-Agent": `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    DS: `${time},${nonce},${digest}`,
  });
}

function responseError(kind: Calculation): never {
  throw new HoyoRequestError("response", `官方${kind}响应格式或角色身份无效。`);
}

function transportError(kind: Calculation): never {
  throw new HoyoRequestError("transport", `官方${kind}请求未完成。`);
}

async function readPayload(response: Response, signal: AbortSignal, kind: Calculation): Promise<Json | undefined> {
  if (!response.body) return;
  if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
    void response.body.cancel().catch(() => undefined);
    responseError(kind);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) responseError(kind);
      text += decoder.decode(next.value, { stream: true });
    }
    return object(JSON.parse(text + decoder.decode()));
  } catch (error) {
    if (error instanceof HoyoRequestError) throw error;
    return;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function verifyIdentity(record: Json, uid: string, region: GenshinBackpackSnapshot["region"], kind: Calculation) {
  for (const field of ["uid", "role_id", "game_uid"] as const) {
    if (Object.hasOwn(record, field) && decimalId(record[field]) !== uid) responseError(kind);
  }
  for (const field of ["server", "region"] as const) {
    if (Object.hasOwn(record, field) && record[field] !== region) responseError(kind);
  }
  if (Object.hasOwn(record, "game_biz") && record.game_biz !== "hk4e_cn") responseError(kind);
}

function normalize(data: Json, uid: string, region: GenshinBackpackSnapshot["region"], kind: Calculation): GenshinGrowthSnapshot {
  verifyIdentity(data, uid, region, kind);
  if (data.role != null) {
    const role = object(data.role) ?? responseError(kind);
    verifyIdentity(role, uid, region, kind);
  }
  if (!Array.isArray(data.overall_consume) || data.overall_consume.length > maxResponseItems) responseError(kind);
  const seen = new Set<string>();
  const items = Array.from(data.overall_consume, (raw): Material => {
    const item = object(raw) ?? responseError(kind);
    const gameId = decimalId(item.game_id);
    const id = decimalId(item.id);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const total = whole(item.num);
    const lack = whole(item.lack_num);
    if (!id || (Object.hasOwn(item, "game_id") && !gameId) || seen.has(id) ||
        !name || !name.isWellFormed() || Buffer.byteLength(name) > 256 || /[\p{Cc}\p{Cf}]/u.test(name) ||
        total === undefined || total < 0 || lack === undefined || lack > total || !Number.isSafeInteger(total - lack)) responseError(kind);
    seen.add(id);
    const icon = typeof item.icon === "string" && item.icon.length <= 2048
      ? normalizeProfileRoleArtworkUrl(item.icon) : undefined;
    return { id, name, total, lack, ...(gameId && { gameId }), ...(icon && { icon }) };
  });
  return { uid, region, items };
}

export async function requestGenshinCalculator(source: ProfileRequestContext, transport: HoyoTransport,
  kind: Calculation, path: CalculatorPath, { query, body, signal, verifyProfile }: {
    readonly query?: URLSearchParams;
    readonly body?: string;
    readonly signal?: AbortSignal;
    readonly verifyProfile?: () => Promise<void>;
  }): Promise<Json> {
  const subject = kind === "原神背包" ? "原神背包查询" : kind;
  const endpoint = new URL(path, calculator);
  if (query) endpoint.search = query.toString();
  const headers = requestHeaders(source, endpoint.search.slice(1), body, kind);
  const guard = async () => {
    if (signal?.aborted) transportError(kind);
    await verifyProfile?.();
    if (signal?.aborted) transportError(kind);
  };
  await guard();
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(endpoint, { method: body === undefined ? "GET" : "POST", body, headers, credentials: "omit",
      redirect: "error", referrerPolicy: "no-referrer", signal: deadline });
  } catch {
    transportError(kind);
  }
  const status = response.status;
  const apiCode = status === 401 || status === 429 ? "http" : "api";
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  const needsChallenge = Boolean(challenge && challenge !== "{}");
  if (deadline.aborted || response.redirected || (!response.ok && status !== 401) || needsChallenge) {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    if (deadline.aborted) transportError(kind);
    if (status === 429) throw new GameRecordRequestError(subject, "rate-limited", "http", status);
    if (needsChallenge) throw new GameRecordRequestError(subject, "risk", apiCode, status);
    throw new HoyoRequestError("http", `官方${kind}接口返回 HTTP 错误。`, status);
  }
  const payload = await readPayload(response, deadline, kind);
  await guard();
  if (deadline.aborted) transportError(kind);
  const retcode = whole(payload?.retcode);
  const message = [payload?.message, payload?.msg, object(payload?.data)?.message]
    .find((value): value is string => typeof value === "string") ?? "";
  if ([1034, 10035, 10041].includes(retcode ?? 0) || /验证码|captcha|geetest|challenge|风控/iu.test(message)) {
    throw new GameRecordRequestError(subject, "risk", apiCode, status, retcode);
  }
  if (retcode === 10101 || /频繁|too frequent|rate limit/iu.test(message)) {
    throw new GameRecordRequestError(subject, "rate-limited", apiCode, status, retcode);
  }
  if (retcode === -100 || (status === 401 && (retcode === 10001 || /未登录|请.*登录|please log\s?in/iu.test(message)))) {
    throw new GameRecordRequestError(subject, "expired", apiCode, status, retcode);
  }
  if (status === 401 || (retcode !== undefined && retcode !== 0)) {
    throw new HoyoRequestError(apiCode, `官方${kind}接口拒绝请求。`, status, retcode);
  }
  const data = object(payload?.data);
  if (retcode !== 0 || !data) responseError(kind);
  return data;
}

async function calculate(source: ProfileRequestContext, transport: HoyoTransport, items: () => readonly GenshinGrowthItem[],
  kind: Calculation, signal?: AbortSignal, verifyProfile?: () => Promise<void>): Promise<GenshinGrowthSnapshot> {
  const uid = source.role.uid;
  const region = genshinCnRecordRegion(source.role);
  if (source.game !== "gs" || !region) {
    throw new HoyoRequestError("invalid-input", `${kind}仅支持当前档案中已确认的国服原神角色。`);
  }
  const body = JSON.stringify({ items: items(), uid, region });
  const data = await requestGenshinCalculator(source, transport, kind, "v3/batch_compute", { body, signal, verifyProfile });
  if (data.has_user_info !== true) {
    throw new HoyoRequestError("response", "官方养成计算器未返回账号背包，请在米游社核对当前角色绑定后重试。");
  }
  return normalize(data, uid, region, kind);
}

export async function readGenshinBackpack(source: ProfileRequestContext, transport: HoyoTransport,
  { probe, signal }: GenshinBackpackOptions, verifyProfile?: () => Promise<void>): Promise<GenshinBackpackSnapshot> {
  const snapshot = await calculate(source, transport, () => probeItems(probe), "原神背包", signal, verifyProfile);
  return { ...snapshot, items: snapshot.items.map(({ total, lack, ...item }) => ({ ...item, count: total - lack, exact: lack !== 0 })) };
}

export async function readGenshinGrowth(source: ProfileRequestContext, transport: HoyoTransport,
  { item, signal }: GenshinGrowthOptions, verifyProfile?: () => Promise<void>): Promise<GenshinGrowthSnapshot> {
  const snapshot = await calculate(source, transport, () => [normalizeGrowthItem(item)], "原神养成计算", signal, verifyProfile);
  return { ...snapshot, items: snapshot.items.map(material => ({ ...material, lack: Math.max(0, material.lack) })) };
}
