import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

// Endpoints used by xiaofei-plugin's original badge activity reader. They remain server-controlled activities.
const activity = { gs: "e20240928anniversary", sr: "e20260426anniversary", zzz: "e20250606anniversary" } as const;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export async function readRegistrationTime(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal }, verify?: () => Promise<void>) {
  const { game, role } = source;
  const global = role.gameBiz?.endsWith("_global") === true;
  const biz = { gs: "hk4e", sr: "hkrpg", zzz: "nap" }[game] + (global ? "_global" : "_cn");
  const regions = global ? { gs: ["os_usa", "os_euro", "os_asia", "os_cht"],
    sr: ["prod_official_usa", "prod_official_euro", "prod_official_asia", "prod_official_cht"],
    zzz: ["prod_gf_us", "prod_gf_eu", "prod_gf_jp", "prod_gf_sg"] } :
    { gs: ["cn_gf01", "cn_qd01"], sr: ["prod_gf_cn", "prod_qd_cn"], zzz: ["prod_gf_cn"] };
  if (!role.region || !regions[game].includes(role.region) || role.gameBiz && role.gameBiz !== biz ||
      !/^\d{5,12}$/u.test(role.uid) || !source.account.cookie.trim() || /[\r\n\0]/u.test(source.account.cookie)) {
    throw new HoyoRequestError("invalid-input", "注册时间查询的账号或角色区域无效。");
  }
  const loginOrigin = global ? "https://sg-public-api.hoyoverse.com" : "https://api-takumi.mihoyo.com";
  const origin = game === "gs" ? global ? "https://sg-hk4e-api.hoyoverse.com" : "https://hk4e-api.mihoyo.com" : loginOrigin;
  const active = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  async function request(url: URL, init: RequestInit) {
    active.throwIfAborted();
    await verify?.();
    active.throwIfAborted();
    const response = await transport(url, { ...init, signal: active, redirect: "error" });
    if (response.redirected || response.url && response.url !== url.href || !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HoyoRequestError("http", "注册时间活动接口请求失败。", response.status);
    }
    const payload = await readGameRecordPayload(response, 512 * 1024, active);
    active.throwIfAborted();
    if (!payload || payload.retcode !== 0 && payload.retcode !== "0" || !object(payload.data)) {
      throw new HoyoRequestError("api", "注册时间活动接口未返回有效数据。", response.status,
        typeof payload?.retcode === "number" ? payload.retcode : undefined);
    }
    return { response, data: object(payload.data)! };
  }
  const login = await request(new URL("/common/badge/v1/login/account", loginOrigin), {
    method: "POST", headers: { Cookie: source.account.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ game_biz: biz, lang: "zh-cn", region: role.region, uid: role.uid }),
  });
  const info = login.data;
  if (String(info.game_uid ?? info.uid) !== role.uid || info.region !== role.region || info.game_biz !== biz) {
    throw new HoyoRequestError("response", "活动登录返回的角色与当前档案不一致。");
  }
  const cookies = login.response.headers.getSetCookie().map(value => value.split(";", 1)[0]!)
    .filter(value => /^[\w-]+=[^;\r\n\0]*$/u.test(value));
  if (!cookies.length) throw new HoyoRequestError("response", "注册时间活动登录未返回会话凭据。");
  const endpoint = new URL(`/event/${activity[game]}/data`, origin);
  endpoint.search = new URLSearchParams({ badge_uid: role.uid, badge_region: role.region, game_biz: biz,
    lang: "zh-cn", ...(game === "sr" && { plat: "2" }) }).toString();
  const result = await request(endpoint, { headers: { Cookie: cookies.join("; ") } });
  let data: unknown = game === "gs" ? result.data.data : result.data.raw_data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { throw new HoyoRequestError("response", "注册时间活动数据格式无效。"); }
  }
  if (!object(data)) throw new HoyoRequestError("response", "注册时间活动数据缺失。");
  await verify?.();
  active.throwIfAborted();
  return { info_data: { game_uid: role.uid, region: role.region, game_biz: biz }, game_data: data, query_time: Date.now() };
}
