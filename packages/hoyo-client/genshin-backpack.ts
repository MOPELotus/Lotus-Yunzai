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

type Json = Record<string, unknown>;
const endpoint = "https://api-takumi.mihoyo.com/event/e20200928calculate/v3/batch_compute";
const subject = "原神背包查询";
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

function probeError(): never {
  throw new HoyoRequestError("invalid-input", "原神背包的养成计算配方无效。");
}

function probeNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) probeError();
  return value;
}

function levels(current: unknown, target: unknown, max: number) {
  const level_current = probeNumber(current, 1, max);
  return { level_current, level_target: probeNumber(target, level_current, max) };
}

function growthTarget(value: unknown, maxLevel: number): GrowthTarget {
  const item = object(value);
  if (!item) probeError();
  return { id: probeNumber(item.id, 1, Number.MAX_SAFE_INTEGER), ...levels(item.level_current, item.level_target, maxLevel) };
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

function requestHeaders(source: ProfileRequestContext, body: string): Headers {
  const { account, device } = source;
  const cookie = account.cookie.trim();
  const validDeviceField = (value: string | undefined): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
  if (!cookie.includes("=") || /[^\x20-\x7E]/u.test(account.cookie) || cookie.length > 16_384 ||
      !validDeviceField(device.id) || !validDeviceField(device.fp)) {
    throw new HoyoRequestError("invalid-input", "原神背包需要当前档案的 Cookie 和已绑定的设备 ID、指纹。");
  }
  const time = Math.round(Date.now() / 1000);
  const nonce = randomInt(100000, 1000000);
  const digest = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}&b=${body}&q=`).digest("hex");
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

function responseError(): never {
  throw new HoyoRequestError("response", "官方原神背包响应格式或角色身份无效。");
}

function transportError(): never {
  throw new HoyoRequestError("transport", "官方原神背包请求未完成。");
}

async function readPayload(response: Response, signal: AbortSignal): Promise<Json | undefined> {
  if (!response.body) return;
  if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
    void response.body.cancel().catch(() => undefined);
    responseError();
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
      if (size > maxResponseBytes) responseError();
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

function verifyIdentity(record: Json, uid: string, region: GenshinBackpackSnapshot["region"]) {
  for (const field of ["uid", "role_id", "game_uid"] as const) {
    if (Object.hasOwn(record, field) && decimalId(record[field]) !== uid) responseError();
  }
  for (const field of ["server", "region"] as const) {
    if (Object.hasOwn(record, field) && record[field] !== region) responseError();
  }
  if (Object.hasOwn(record, "game_biz") && record.game_biz !== "hk4e_cn") responseError();
}

function normalize(data: Json, uid: string, region: GenshinBackpackSnapshot["region"]): GenshinBackpackSnapshot {
  verifyIdentity(data, uid, region);
  if (data.role != null) {
    const role = object(data.role) ?? responseError();
    verifyIdentity(role, uid, region);
  }
  if (!Array.isArray(data.overall_consume) || data.overall_consume.length > maxResponseItems) responseError();
  const seen = new Set<string>();
  const items = Array.from(data.overall_consume, (raw): GenshinBackpackItem => {
    const item = object(raw) ?? responseError();
    const gameId = decimalId(item.game_id);
    const id = decimalId(item.id);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const total = whole(item.num);
    const lack = whole(item.lack_num);
    if (!id || (Object.hasOwn(item, "game_id") && !gameId) || seen.has(id) ||
        !name || !name.isWellFormed() || Buffer.byteLength(name) > 256 || /[\p{Cc}\p{Cf}]/u.test(name) ||
        total === undefined || total < 0 || lack === undefined || lack > total || !Number.isSafeInteger(total - lack)) responseError();
    seen.add(id);
    const icon = typeof item.icon === "string" && item.icon.length <= 2048
      ? normalizeProfileRoleArtworkUrl(item.icon) : undefined;
    return { id, name, count: total - lack, exact: lack !== 0, ...(gameId && { gameId }), ...(icon && { icon }) };
  });
  return { uid, region, items };
}

export async function readGenshinBackpack(source: ProfileRequestContext, transport: HoyoTransport,
  { probe, signal }: GenshinBackpackOptions, verifyProfile?: () => Promise<void>): Promise<GenshinBackpackSnapshot> {
  const uid = source.role.uid;
  const region = genshinCnRecordRegion(source.role);
  if (source.game !== "gs" || !region) {
    throw new HoyoRequestError("invalid-input", "原神背包仅支持当前档案中已确认的国服原神角色。");
  }
  const body = JSON.stringify({ items: probeItems(probe), uid, region });
  const headers = requestHeaders(source, body);
  const guard = async () => {
    if (signal?.aborted) transportError();
    await verifyProfile?.();
    if (signal?.aborted) transportError();
  };
  await guard();
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(new URL(endpoint), { method: "POST", body, headers, credentials: "omit",
      redirect: "error", referrerPolicy: "no-referrer", signal: deadline });
  } catch {
    transportError();
  }
  const status = response.status;
  const apiCode = status === 401 || status === 429 ? "http" : "api";
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  const needsChallenge = Boolean(challenge && challenge !== "{}");
  if (deadline.aborted || response.redirected || (!response.ok && status !== 401) || needsChallenge) {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    if (deadline.aborted) transportError();
    if (status === 429) throw new GameRecordRequestError(subject, "rate-limited", "http", status);
    if (needsChallenge) throw new GameRecordRequestError(subject, "risk", apiCode, status);
    throw new HoyoRequestError("http", "官方原神背包接口返回 HTTP 错误。", status);
  }
  const payload = await readPayload(response, deadline);
  await guard();
  if (deadline.aborted) transportError();
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
    throw new HoyoRequestError(apiCode, "官方原神背包接口拒绝请求。", status, retcode);
  }
  const data = object(payload?.data);
  if (retcode !== 0 || !data) responseError();
  if (data.has_user_info !== true) {
    throw new HoyoRequestError("response", "官方养成计算器未返回账号背包，请在米游社核对当前角色绑定后重试。");
  }
  return normalize(data, uid, region);
}
