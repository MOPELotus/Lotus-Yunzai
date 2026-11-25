import { createHash, randomInt } from "node:crypto";
import type { Game } from "@lotus-yunzai/account";
import { getDefaultCaptchaSolver, type CaptchaChallenge, type CaptchaEvent, type CaptchaProof } from "./captcha.ts";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

type Json = Record<string, unknown>;
type V3Challenge = Extract<CaptchaChallenge, { captchaVersion: 3 }>;
interface Captured {
  readonly url: URL;
  readonly init: Parameters<HoyoTransport>[1];
  readonly payload: Json;
  readonly trace?: string;
}
export interface CaptchaBusinessOptions {
  readonly signal?: AbortSignal;
  readonly verify?: () => Promise<void>;
  readonly game?: Game;
  readonly context?: { readonly qq: string; readonly profileId: number };
  readonly notify?: (event: CaptchaEvent) => unknown;
  readonly allowManual?: boolean;
  readonly verificationCookie?: () => string;
}
const obj = (value: unknown): Json | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const code = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : typeof value === "string" && /^-?\d{1,9}$/u.test(value) ? Number(value) : undefined;
const field = (value: unknown, limit = 2048): value is string => typeof value === "string" && value.length > 0 && value.length <= limit && /^[!-~]+$/u.test(value);
const authCodes = new Set([-100, 10001, 10101, 10102, 10103, 10041]);
function rateLimited(payload: Json) {
  return code(payload.retcode) === 429 || /频繁|频率限制|请求过快|操作太快|too frequent|rate.?limit/iu.test(String(payload.message ?? payload.msg ?? ""));
}
function risk(payload: Json) {
  const retcode = code(payload.retcode);
  if (retcode === 10041) return false;
  if (retcode === 1034 || retcode === 10035) return true;
  if (retcode !== 0) return false;
  const data = obj(payload.data);
  return [data, obj(data?.gt_result)].some(row => row?.is_risk === true || (code(row?.is_risk) ?? 0) > 0 || code(row?.success) === 1 || code(row?.risk_code) === 375);
}
function inline(payload: Json): V3Challenge | undefined {
  const data = obj(payload.data);
  const challenge = obj(data?.gt_result) ?? data;
  if (!challenge || [challenge.captchaVersion, challenge.captcha_version, challenge.version].some(version => version !== undefined && ![3, "3", "v3"].includes(version as number | string)) ||
      challenge.captchaId !== undefined || challenge.captcha_id !== undefined || !field(challenge.gt, 256) || !field(challenge.challenge, 1024)) return;
  const flag = (value: unknown) => value === true || value === false || value === 0 || value === 1 ? value : undefined;
  return { captchaVersion: 3, gt: challenge.gt, challenge: challenge.challenge, new_captcha: flag(challenge.new_captcha), success: flag(challenge.success) };
}
function registered(url: URL, game?: Game): { kind: "bbs" | "record" | "tool" | "inline"; overseas: boolean; game?: Game } | undefined {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return;
  if (url.origin === "https://bbs-api.miyoushe.com" && /^\/apihub\/(?:app\/api\/signIn|wapi\/getUserMissionsState)$/u.test(url.pathname)) return { kind: "bbs", overseas: false };
  if (url.origin === "https://sg-act-public-api.hoyolab.com" && /^\/event\/(?:sol|luna\/(?:hkrpg|zzz)\/os)\/sign$/u.test(url.pathname)) return { kind: "inline", overseas: true };
  const hosts = new Set(["api-takumi.mihoyo.com", "api-takumi-record.mihoyo.com", "act-nap-api.mihoyo.com", "sg-public-api.hoyolab.com", "sg-act-nap-api.hoyolab.com", "sg-act-public-api.hoyolab.com", "bbs-api-os.hoyolab.com"]);
  if (!hosts.has(url.hostname) || !/^\/(?:game_record\/|event\/game_record_zzz\/api\/)/u.test(url.pathname)) return;
  const resolved = game ?? (/\/genshin\//u.test(url.pathname) ? "gs" : /\/hkrpg\//u.test(url.pathname) ? "sr" : /game_record_zzz/u.test(url.pathname) ? "zzz" : undefined);
  if (!resolved) return;
  return { kind: "record", overseas: url.hostname.endsWith("hoyolab.com"), game: resolved };
}
function requestKey(url: URL, init: Parameters<HoyoTransport>[1]) {
  const headers = new Headers(init.headers);
  return JSON.stringify([url.href, init.method ?? "GET", init.body ?? null, headers.get("Cookie"), headers.get("x-rpc-device_id"), headers.get("x-rpc-device_fp")]);
}
function originalPath(url: URL) {
  if (url.origin === "https://api-takumi-record.mihoyo.com") {
    for (const base of ["/event/game_record_zzz/api", "/game_record/app", "/game_record"]) if (url.pathname.startsWith(base + "/")) return url.pathname.slice(base.length);
  }
  return url.pathname;
}
function businessHeaders(captured: Captured, overseas: boolean, query: string, body?: string, bbs = false): Headers {
  const headers = new Headers(captured.init.headers);
  for (const key of ["x-rpc-challenge", "x-rpc-validate", "x-rpc-seccode", "Content-Length", "Host"]) headers.delete(key);
  const time = Math.floor(Date.now() / 1000), nonce = bbs ? Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[randomInt(36)]).join("") : randomInt(100000, 1000000);
  const salt = bbs ? "9c7b896d7483e9070b27c55f1959c4d5" : overseas ? "okr4obncj8bw5a65hbnn5oo6ixjc3l9w" : "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
  const digest = createHash("md5").update(bbs ? `salt=${salt}&t=${time}&r=${nonce}` : `salt=${salt}&t=${time}&r=${nonce}&b=${body ?? ""}&q=${query}`).digest("hex");
  headers.set("DS", `${time},${nonce},${digest}`);
  if (bbs) { headers.set("x-rpc-client_type", "2"); headers.set("User-Agent", "okhttp/4.9.3"); }
  headers.set("x-rpc-app_version", overseas ? "4.23.0" : "2.118.1");
  headers.set("x-rpc-challenge_path", originalPath(captured.url));
  if (captured.trace) headers.set("x-rpc-challenge_trace", captured.trace); else headers.delete("x-rpc-challenge_trace");
  const game = /\/hkrpg\//u.test(captured.url.pathname) ? "6" : /game_record_zzz/u.test(captured.url.pathname) ? "8" : /\/genshin\//u.test(captured.url.pathname) ? "2" : undefined;
  if (game) headers.set("x-rpc-challenge_game", game);
  if (body !== undefined) headers.set("Content-Type", "application/json"); else headers.delete("Content-Type");
  return headers;
}

/** Recover only registered official requests, after the original per-request deadline has ended. */
export async function withMiyousheCaptcha<T>(transport: HoyoTransport, operation: (request: HoyoTransport) => Promise<T>, options: CaptchaBusinessOptions = {}): Promise<T> {
  const solver = getDefaultCaptchaSolver();
  if (!solver) return operation(transport);
  const signal = options.signal ?? new AbortController().signal;
  const guard = async () => { signal.throwIfAborted(); await options.verify?.(); signal.throwIfAborted(); };
  // Re-running a reader reuses its previous responses; it never replays an earlier successful write.
  const cache = new Map<string, Response>();
  let captured: Captured | undefined;
  let replaying = false;
  let rpc: { key: string; headers: HeadersInit } | undefined;
  const request: HoyoTransport = async (url, init) => {
    await guard();
    const key = requestKey(url, init), previous = cache.get(key);
    if (replaying && previous) return previous.clone();
    // Bun's proxied connections must not outlive retained replay response branches.
    // Keep each official attempt independent while preserving the original headers.
    let outgoing = { ...init, keepalive: false };
    if (rpc?.key === key) {
      const headers = new Headers(init.headers);
      for (const [name, value] of new Headers(rpc.headers)) headers.set(name, value);
      outgoing = { ...outgoing, headers };
    }
    const response = await transport(url, outgoing);
    await guard();
    if (url.origin === "https://public-data-api.mihoyo.com" && url.pathname === "/device-fp/api/getFp") return response;
    if (!response.ok || response.redirected || (response.url && response.url !== url.href)) return response;
    const route = ["GET", "POST"].includes((init.method ?? "GET").toUpperCase()) && (init.body === undefined || typeof init.body === "string") ? registered(url, options.game) : undefined;
    // Do not await cancellation of an oversized tee before the business can read its branch.
    if (route && !(Number(response.headers.get("Content-Length")) > 512 * 1024)) {
      const payload = await readGameRecordPayload(response.clone(), 512 * 1024, init.signal ?? signal);
      if (payload && !rateLimited(payload) && risk(payload)) {
        // A successful envelope on a write must carry its inline challenge. Otherwise it is ambiguous.
        if (code(payload.retcode) === 0 && (init.method ?? "GET").toUpperCase() !== "GET" && !inline(payload)) return response;
        captured = { url, init, payload, trace: response.headers.get("x-trace-id")?.trim() || undefined };
        return response;
      }
    }
    cache.set(key, response.clone());
    return response;
  };
  let originalError: unknown;
  try { return await operation(request); } catch (error) { originalError = error; }
  if (!captured || !(originalError instanceof HoyoRequestError) || !("reason" in originalError) || originalError.reason !== "risk") throw originalError;
  replaying = true;
  const target: Captured = captured;
  const route = registered(target.url, options.game)!;
  if (route.kind === "inline" && !inline(target.payload)) throw originalError;
  const tool = code(target.payload.retcode) === 10035;
  const appKey = route.game === "sr" ? "hkrpg_game_record" : route.game === "zzz" ? "game_record_zzz" : undefined;
  if (route.kind === "record" && tool && !appKey) throw originalError;
  const query = target.url.searchParams;
  let body: Json | undefined;
  if (typeof target.init.body === "string") { try { body = obj(JSON.parse(target.init.body)); } catch { /* Registered request parsers reject malformed JSON. */ } }
  const uid = query.get("role_id") ?? query.get("uid") ?? body?.role_id ?? body?.uid;
  const region = query.get("server") ?? query.get("region") ?? body?.server ?? body?.region;
  const data = obj(target.payload.data);
  for (const row of [data, obj(data?.role)]) {
    if (route.kind === "record" && row && ((uid !== undefined && uid !== null && ["uid", "role_id", "game_uid"].some(key => row[key] !== undefined && String(row[key]) !== String(uid))) ||
        (region !== undefined && region !== null && ["region", "server"].some(key => row[key] !== undefined && row[key] !== region)))) {
      throw new HoyoRequestError("response", "验证码响应与原请求角色不一致。");
    }
  }
  const targetKey = requestKey(target.url, target.init);
  async function api(path: string, body?: Json): Promise<Json> {
    await guard();
    const overseas = route.overseas;
    const origin = route.kind === "bbs" ? target.url.origin : tool
      ? overseas ? "https://sg-public-api.hoyolab.com" : "https://api-takumi.mihoyo.com"
      : overseas ? "https://bbs-api-os.hoyolab.com" : "https://api-takumi-record.mihoyo.com";
    const url = new URL(path, origin), encoded = body === undefined ? undefined : JSON.stringify(body);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const headers = businessHeaders(target, overseas, url.search.slice(1), encoded, route.kind === "bbs");
    if (route.kind === "bbs" && options.verificationCookie) headers.set("Cookie", options.verificationCookie());
    const response = await transport(url, { method: body === undefined ? "GET" : "POST", headers, body: encoded,
      signal: deadline, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok || response.redirected || (response.url && response.url !== url.href)) {
      await response.body?.cancel().catch(() => undefined);
      throw new HoyoRequestError("http", "验证码业务接口请求未完成。", response.status);
    }
    const payload = await readGameRecordPayload(response, 128 * 1024, deadline);
    await guard();
    if (!payload || code(payload.retcode) === undefined) throw new HoyoRequestError("response", "验证码业务接口响应无效。");
    if (rateLimited(payload)) throw new HoyoRequestError("api", "验证码业务接口请求频繁。", response.status, code(payload.retcode));
    if (authCodes.has(code(payload.retcode)!)) throw new HoyoRequestError("api", "验证码业务账号状态已变化。", response.status, code(payload.retcode));
    return payload;
  }
  let firstInline = inline(target.payload);
  const solved = await solver.run<T>({ signal, verify: guard, context: options.context, notify: options.notify,
    allowManual: options.allowManual ?? Boolean(options.context || options.notify),
    async challenge() {
      if (route.kind === "inline") {
        if (firstInline) { const first = firstInline; firstInline = undefined; return first; }
        // The last write was explicitly refused by the business; obtaining a new challenge is safe.
        captured = undefined; rpc = undefined;
        try { return { completed: await operation(request) }; }
        catch (error) {
          const updated = captured as Captured | undefined;
          if (updated && requestKey(updated.url, updated.init) === targetKey && inline(updated.payload) && error instanceof HoyoRequestError && "reason" in error && error.reason === "risk") return inline(updated.payload)!;
          throw error;
        }
      }
      const path = route.kind === "bbs" ? "/misc/api/createVerification?is_high=true" : tool
        ? `/event/toolcomsrv/risk/createGeetest?is_high=true&app_key=${encodeURIComponent(appKey!)}`
        : "/game_record/app/card/wapi/createVerification?is_high=true";
      const created = await api(path);
      const challenge = inline(created);
      if (code(created.retcode) !== 0 || !challenge) throw new HoyoRequestError("response", "官方未返回受支持的验证码挑战。");
      return challenge;
    },
    async accept(proof: CaptchaProof) {
      if (!("validate" in proof) || !field(proof.challenge, 1024) || !field(proof.validate) || proof.seccode !== `${proof.validate}|jordan`) return { accepted: false };
      let headers: HeadersInit;
      if (route.kind === "inline") headers = { "x-rpc-challenge": proof.challenge, "x-rpc-validate": proof.validate, "x-rpc-seccode": proof.seccode };
      else {
        const path = route.kind === "bbs" ? "/misc/api/verifyVerification" : tool ? "/event/toolcomsrv/risk/verifyGeetest" : "/game_record/app/card/wapi/verifyVerification";
        const result = await api(path, { geetest_challenge: proof.challenge, geetest_validate: proof.validate, geetest_seccode: proof.seccode, ...(tool && { app_key: appKey }) });
        const challenge = obj(result.data)?.challenge;
        if (code(result.retcode) !== 0) return { accepted: false };
        if (!field(challenge)) throw new HoyoRequestError("response", "官方验证码校验缺少业务凭证。");
        headers = { "x-rpc-challenge": challenge };
      }
      await guard();
      rpc = { key: targetKey, headers }; captured = undefined;
      try { return { accepted: true, value: await operation(request) }; }
      catch (error) {
        const updated = captured as Captured | undefined;
        if (updated && requestKey(updated.url, updated.init) === targetKey && error instanceof HoyoRequestError && "reason" in error && error.reason === "risk") return { accepted: false };
        throw error;
      } finally { rpc = undefined; }
    },
  });
  await guard();
  if (solved.ok) return solved.value;
  throw originalError;
}
