import { setTimeout as wait } from "node:timers/promises";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { GameRecordRequestError, readGameRecordPayload } from "./game-record.ts";

export const starRailGachaPools = Object.freeze({
  GachaType_AvatarUp: "角色活动跃迁",
  GachaType_EquipmentUp: "光锥活动跃迁",
  GachaType_CollabAvatarUp: "联动角色跃迁",
  GachaType_CollabEquipmentUp: "联动光锥跃迁",
  GachaType_Standard: "常驻跃迁",
  GachaType_Newbie: "新手跃迁",
});

export type StarRailGachaPool = keyof typeof starRailGachaPools;
export interface StarRailGachaOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
}

const badgeLogin = "https://api-takumi.mihoyo.com/common/badge/v1/login/account";
const activityRoot = "https://act-api-takumi.mihoyo.com/event/rpg_gacha_record/";
const activityOrigin = "https://act.mihoyo.com";
const maxPages = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseRetcode(value: unknown): number | undefined {
  const number = typeof value === "string" && /^-?\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number)) return number;
}

function reportsRateLimit(payload: Record<string, unknown> | undefined) {
  const message = [payload?.message, payload?.msg].filter((value): value is string => typeof value === "string").join(" ");
  return /visit too frequently|too frequent|rate limit|频繁/iu.test(message) &&
    !/验证码|captcha|geetest|challenge|风控/iu.test(message);
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new HoyoRequestError("response", `星铁抽卡响应缺少有效的${label}。`);
  return value;
}

function identifier(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number {
  const numeric = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0) {
    throw new HoyoRequestError("response", "星铁抽卡响应的抽数无效。");
  }
  return numeric;
}

function parseBrief(data: Record<string, unknown>) {
  const items = requiredArray(data.items, "简要统计").map((entry) => {
    if (!isRecord(entry)) throw new HoyoRequestError("response", "星铁抽卡简要统计格式有误。");
    return { item: entry.item ?? null, count: count(entry.count) };
  });
  return { version_id: identifier(data.version_id), items };
}

function parseCards(data: Record<string, unknown>) {
  return requiredArray(data.cards, "卡池统计").map((card) => {
    if (!isRecord(card) || !identifier(card.gacha_id)) {
      throw new HoyoRequestError("response", "星铁卡池统计缺少有效的卡池编号。");
    }
    return {
      ...card, gacha_id: identifier(card.gacha_id), total_count: count(card.total_count),
      up_count: count(card.up_count ?? 0),
    };
  });
}

function parseFiveStar(row: Record<string, unknown>) {
  const { item, id, uuid, is_up, time } = row;
  if (!isRecord(item) || !identifier(item.item_id) ||
      [id, uuid].some((value) => typeof value === "number" && !Number.isSafeInteger(value)) ||
      !(identifier(id) || identifier(uuid))) {
    throw new HoyoRequestError("response", "星铁五星记录或编号无效。");
  }
  return {
    id: identifier(id), uuid: identifier(uuid), item,
    ...(typeof is_up === "boolean" ? { is_up } : {}),
    ...(typeof time === "string" && time.trim() ? { time: time.trim() } : {}),
    got_item: row.got_item ?? null, gacha_count: count(row.gacha_count),
  };
}

export function resolveStarRailGachaRegion(source: ProfileRequestContext): string {
  const { uid, gameBiz } = source.role;
  const explicit = source.role.region.trim();
  const inferred = /^[125]\d{8}$/u.test(uid) ? uid.startsWith("5") ? "prod_qd_cn" : "prod_gf_cn" : "";
  const region = explicit || inferred;
  if (source.game !== "sr" || !/^[1-9]\d*$/u.test(uid) || (gameBiz && gameBiz !== "hkrpg_cn") ||
      (region !== "prod_gf_cn" && region !== "prod_qd_cn") || /^(?:[6789]|18)\d{8}$/u.test(uid)) {
    throw new HoyoRequestError("invalid-input", "星铁官方小程序仅支持已确认的国服星铁档案区服。");
  }
  return region;
}

type ActivityRequest = (
  endpoint: "brief" | "pool_stat" | "five_star_list",
  query?: Record<string, string>,
) => Promise<Record<string, unknown>>;

async function readFiveStars(request: ActivityRequest, type: StarRailGachaPool, pause: () => Promise<void>) {
  const records: ReturnType<typeof parseFiveStar>[] = [];
  const seen = new Set<string>();
  let cursor: Record<string, string> = {};
  let pity: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await request("five_star_list", { gacha_type: type, ...cursor });
    if (typeof data.has_more !== "boolean") {
      throw new HoyoRequestError("response", "星铁五星列表缺少明确的分页状态。");
    }
    for (const row of requiredArray(data.list, "五星列表")) {
      if (!isRecord(row)) throw new HoyoRequestError("response", "星铁五星列表包含无效条目。");
      if (row.item === null) {
        const latestPity = count(row.gacha_count);
        pity ??= latestPity;
      } else {
        records.push(parseFiveStar(row));
      }
    }
    if (!data.has_more) return { fiveStars: records, pity };

    const version = identifier(data.version_id);
    const next = identifier(data.next_max_id);
    const key = JSON.stringify([version, next]);
    if (!version || !next || next === "0" || seen.has(key)) {
      throw new HoyoRequestError("response", "星铁五星列表的下一页游标缺失或重复。");
    }
    cursor = { version_id: version, max_id: next };
    seen.add(key);
    if (page + 1 < maxPages) await pause();
  }
  throw new HoyoRequestError("response", "星铁五星列表超过分页上限，本次未取完。");
}

export async function readStarRailGacha(
  source: ProfileRequestContext,
  transport: HoyoTransport,
  { signal, intervalMs = 300 }: StarRailGachaOptions,
  verifyProfile?: () => Promise<void>,
) {
  const region = resolveStarRailGachaRegion(source);
  const uid = source.role.uid;
  const initialCookie = source.account.cookie;
  if (!initialCookie.trim() || /[\r\n\0]/u.test(initialCookie) ||
      !Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
    throw new HoyoRequestError("invalid-input", "星铁活动请求的档案 Cookie 或间隔无效。");
  }

  async function check() {
    if (signal?.aborted) throw new HoyoRequestError("transport", "星铁抽卡请求已取消。");
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", "星铁抽卡请求已取消。");
  }

  async function pause() {
    if (!intervalMs) return;
    try {
      await wait(intervalMs, undefined, { signal });
    } catch {
      throw new HoyoRequestError("transport", "星铁抽卡请求已取消。");
    }
  }

  const jar = new Map<string, string>();
  function storeCookie(pair: string) {
    const separator = pair.indexOf("=");
    if (separator <= 0) return;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!/^[\w-]+$/u.test(key) || /[;\r\n\0]/u.test(value)) return;
    if (value) jar.set(key, value);
    else jar.delete(key);
  }
  for (const pair of initialCookie.split(";")) storeCookie(pair);
  jar.delete("e_hkrpg_token");
  if (!jar.size) throw new HoyoRequestError("invalid-input", "星铁档案 Cookie 格式无效。");

  async function request(url: URL, referer: string, init: RequestInit = {}) {
    await check();
    const timeout = AbortSignal.timeout(30_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json, text/plain, */*");
      headers.set("Cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
      headers.set("Origin", activityOrigin);
      headers.set("Referer", referer);
      headers.set("User-Agent", "Mozilla/5.0 Lotus-StarRail-Gacha");
      response = await transport(url, {
        ...init, headers, redirect: "error", signal: deadline,
      });
    } catch {
      throw new HoyoRequestError("transport", "星铁抽卡请求未完成。");
    }
    if (!response.ok) {
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        throw new GameRecordRequestError("星铁抽卡查询", "rate-limited", "http", response.status);
      }
      if (response.status === 401) {
        const payload = await readGameRecordPayload(response, 16 * 1024, deadline);
        const message = [payload?.msg, payload?.message].filter((value): value is string => typeof value === "string").join(" ");
        const challenge = response.headers.get("x-rpc-aigis")?.trim();
        if ((!challenge || challenge === "{}") && !deadline.aborted && reportsRateLimit(payload)) {
          throw new GameRecordRequestError("星铁抽卡查询", "rate-limited", "http", response.status, responseRetcode(payload?.retcode));
        }
        if ((!challenge || challenge === "{}") && !/验证码|captcha|geetest|challenge|风控/iu.test(message) &&
            !deadline.aborted && responseRetcode(payload?.retcode) === -100) {
          throw new HoyoRequestError("api", "星铁抽卡接口拒绝请求。", response.status, -100);
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new HoyoRequestError("http", "星铁抽卡接口返回 HTTP 错误。", response.status);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const retcode = isRecord(payload) ? responseRetcode(payload.retcode) : undefined;
    if (!isRecord(payload) || retcode === undefined) {
      throw new HoyoRequestError("response", "星铁抽卡接口响应格式有误。");
    }
    if (retcode !== 0) {
      if (reportsRateLimit(payload)) {
        throw new GameRecordRequestError("星铁抽卡查询", "rate-limited", "api", response.status, retcode);
      }
      throw new HoyoRequestError("api", "星铁抽卡接口拒绝请求。", response.status, retcode);
    }
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";", 1)[0];
      if (pair) storeCookie(pair);
    }
    return payload;
  }

  await request(new URL(badgeLogin), `${activityOrigin}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid, region, game_biz: "hkrpg_cn", lang: "zh-cn" }),
  });
  if (!jar.has("e_hkrpg_token")) {
    throw new HoyoRequestError("response", "星铁活动登录没有返回活动凭据。");
  }

  const deviceId = source.device.id || crypto.randomUUID().replaceAll("-", "");
  const activity: ActivityRequest = async (endpoint, extra) => {
    const url = new URL(endpoint, activityRoot);
    url.search = new URLSearchParams({
      badge_region: region, badge_uid: uid, game_biz: "hkrpg_cn", region, uid, ...extra,
    }).toString();
    const payload = await request(url, `${activityOrigin}/sr/event/gt-aio/gacha-records/index.html`, {
      headers: { "x-rpc-device_id": deviceId, "x-rpc-jump_source": "wechatmp", "x-rpc-platform": "4" },
    });
    if (!isRecord(payload.data)) throw new HoyoRequestError("response", "星铁抽卡响应缺少活动数据。");
    return payload.data;
  };

  const brief = parseBrief(await activity("brief"));
  const pools: {
    type: StarRailGachaPool;
    name: string;
    cards: ReturnType<typeof parseCards>;
    fiveStars: ReturnType<typeof parseFiveStar>[];
    pity: number | null;
  }[] = [];
  for (const type of Object.keys(starRailGachaPools) as StarRailGachaPool[]) {
    if (pools.length) await pause();
    const cards = parseCards(await activity("pool_stat", { gacha_type: type }));
    const { fiveStars, pity } = await readFiveStars(activity, type, pause);
    pools.push({ type, name: starRailGachaPools[type], cards, fiveStars, pity });
  }
  await check();
  return { uid, region, brief, pools };
}
