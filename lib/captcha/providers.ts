import { setTimeout as sleep } from "node:timers/promises";
import type { CaptchaChallenge, CaptchaProof } from "@lotus-yunzai/hoyo-client";
import { readGameRecordPayload } from "@lotus-yunzai/hoyo-client";

export type ProviderId = "local" | "ttocr" | "manual";
export interface CaptchaConfig {
  readonly enabled: boolean;
  readonly order: readonly ProviderId[];
  readonly manual: { readonly enabled: boolean };
  readonly local: { readonly enabled: boolean; readonly timeoutMs: number };
  readonly ttocr: { readonly enabled: boolean; readonly key: string; readonly api: string; readonly resultApi: string;
    readonly timeoutMs: number; readonly pollMs: number; readonly itemid: string; readonly itemidV4: string; readonly referer: string };
}
export class ProviderFailure extends Error {
  constructor(readonly reason: string, readonly retryable = true, readonly code?: number) { super(reason); }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function duration(value: unknown, fallback: number, min = 1) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= 600_000 ? value : fallback;
}
function endpoint(value: unknown, fallback: string) {
  const raw = typeof value === "string" ? value.trim() : fallback;
  const url = URL.parse(raw);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError("验证码服务地址无效。");
  }
  return url.href;
}
export function captchaConfig(input: unknown): CaptchaConfig {
  const source = object(input), local = object(source.local ?? source.test_nine), ttocr = object(source.ttocr);
  const aliases: Record<string, ProviderId> = { local: "local", test_nine: "local", ttocr: "ttocr", gtmanual: "manual", manual: "manual" };
  const manual = object(source.manual ?? source.gtmanual);
  const configured = source.providers ?? source.order;
  const order = Array.isArray(configured) ? [...new Set(configured.map(id => aliases[String(id)]).filter((id): id is ProviderId => !!id))]
    : ["local", "ttocr", "manual"] as const;
  if (!order.length) throw new TypeError("验证码提供方顺序无效。");
  return {
    enabled: source.enable !== false, order, manual: { enabled: manual.enable !== false },
    local: { enabled: local.enable !== false, timeoutMs: duration(local.timeout_ms, 120_000) },
    ttocr: { enabled: ttocr.enable !== false && typeof ttocr.key === "string" && !!ttocr.key.trim() && ttocr.key !== "脱敏",
      key: typeof ttocr.key === "string" ? ttocr.key.trim() : "",
      api: endpoint(ttocr.api, "http://api.ttocr.com/api/recognize"),
      resultApi: endpoint(ttocr.resapi, "http://api.ttocr.com/api/results"),
      timeoutMs: duration(ttocr.timeout_ms, 60_000), pollMs: duration(ttocr.poll_interval_ms, 2000, 2000),
      itemid: String(ttocr.itemid ?? 388), itemidV4: String(ttocr.itemid_v4 ?? 488),
      referer: typeof ttocr.referer === "string" ? ttocr.referer : "https://webstatic.mihoyo.com/" },
  };
}
const field = (value: unknown, limit = 2048): value is string => typeof value === "string" && value.length > 0 && value.length <= limit && /^[!-~]+$/u.test(value);
/** Accept both SDK and wire names, but never accept conflicting aliases or versions. */
export function normalizeCaptchaProof(raw: unknown, challenge: CaptchaChallenge): CaptchaProof | undefined {
  const data = object(raw);
  for (const [a, b] of [["captchaId", "captcha_id"], ["lotNumber", "lot_number"], ["captchaOutput", "captcha_output"], ["passToken", "pass_token"], ["genTime", "gen_time"], ["challenge", "geetest_challenge"], ["validate", "geetest_validate"], ["seccode", "geetest_seccode"]] as const) {
    if (data[a] !== undefined && data[b] !== undefined && data[a] !== data[b]) return;
  }
  const alias = (a: string, b: string) => data[a] !== undefined && data[b] !== undefined && data[a] !== data[b] ? undefined : data[a] ?? data[b];
  const versions = [data.captchaVersion, data.captcha_version, data.version].filter(value => value !== undefined).map(value => String(value).replace(/^v/u, ""));
  if (versions.some(value => value !== String(challenge.captchaVersion))) return;
  if (challenge.captchaVersion === 4) {
    if ([data.validate, data.geetest_validate, data.seccode, data.geetest_seccode].some(value => value !== undefined)) return;
    const captchaId = alias("captchaId", "captcha_id") ?? challenge.captchaId;
    const lotNumber = alias("lotNumber", "lot_number"), captchaOutput = alias("captchaOutput", "captcha_output");
    const passToken = alias("passToken", "pass_token"), time = alias("genTime", "gen_time");
    const genTime = typeof time === "number" && Number.isSafeInteger(time) ? String(time) : time;
    if (captchaId !== challenge.captchaId || !field(lotNumber) || !field(captchaOutput) || !field(passToken) ||
        typeof genTime !== "string" || !/^\d{1,32}$/u.test(genTime)) return;
    return { captchaVersion: 4, captchaId, lotNumber, captchaOutput, passToken, genTime };
  }
  if (["captchaId", "captcha_id", "lotNumber", "lot_number", "captcha_output", "captchaOutput", "pass_token", "passToken", "gen_time", "genTime"].some(key => key in data)) return;
  const returnedChallenge = alias("challenge", "geetest_challenge") ?? challenge.challenge;
  const validate = alias("validate", "geetest_validate");
  const seccode = alias("seccode", "geetest_seccode") ?? (typeof validate === "string" ? `${validate}|jordan` : undefined);
  if (!field(returnedChallenge, 1024) || !field(validate) || seccode !== `${validate}|jordan`) return;
  return { challenge: returnedChallenge, validate, seccode };
}
type LocalSolver = ReturnType<typeof import("@lotus-yunzai/captcha").createLocalCaptchaSolver>;
export function createAutomaticProviders(config: CaptchaConfig, { fetchImpl = fetch, now = Date.now, createLocalSolver,
  wait = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }),
}: { fetchImpl?: typeof fetch; now?: () => number; wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
  createLocalSolver?: () => Promise<LocalSolver> } = {}) {
  let local: Promise<LocalSolver> | undefined;
  let closed = false;
  function localSolver() {
    if (closed) throw new ProviderFailure("service_closed", false);
    return local ??= (createLocalSolver ? createLocalSolver() : import("@lotus-yunzai/captcha").then(module => module.createLocalCaptchaSolver()))
      .catch(error => { local = undefined; throw error; });
  }
  let cooldownUntil = 0;
  const polls = new Map<string, Promise<void>>();
  const fatal = new Set([4001,4002,4003,4004,4005,4006,4007,4008,4009,4010,4011,4012,4013,4018,4021,4023,4038,4100,4101,4103,4106,4030]);
  const terminal = new Set([...fatal,4014,4022,4024,4026,4028,4039]);
  async function json(url: string, body: string, type: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": type }, body,
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal });
    signal.throwIfAborted();
    if (response.redirected || !response.ok || (response.url && response.url !== url)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderFailure("provider_http");
    }
    const data = await readGameRecordPayload(response, 64 * 1024, signal);
    if (!data) throw new ProviderFailure("provider_response");
    return data;
  }
  function classify(data: Record<string, unknown>): never {
    const code = Number(data.status);
    if (code === 4030 || (code === 4006 && /IP.*(?:拉黑|blacklist)|blacklist.*IP/iu.test(String(data.msg)))) cooldownUntil = now() + 30 * 60_000;
    throw new ProviderFailure(Number.isSafeInteger(code) ? `ttocr_${code}` : "ttocr_response", !fatal.has(code), Number.isSafeInteger(code) ? code : undefined);
  }
  async function form(url: string, fields: URLSearchParams, signal: AbortSignal) {
    if (now() < cooldownUntil) throw new ProviderFailure("ttocr_cooldown", false);
    const data = await json(url, fields.toString(), "application/x-www-form-urlencoded", signal);
    const code = Number(data.status);
    if (code === 4030 || code === 4006) classify(data);
    return data;
  }
  return {
    async close() {
      closed = true;
      if (local) await local.then(solver => solver.close()).catch(() => undefined);
    },
    available(id: ProviderId) { return !closed && (id === "local" ? config.local.enabled : id === "ttocr" && config.ttocr.enabled && now() >= cooldownUntil); },
    async solve(id: "local" | "ttocr", challenge: CaptchaChallenge, outer: AbortSignal): Promise<CaptchaProof> {
      if (closed) throw new ProviderFailure("service_closed", false);
      const settings = config[id];
      const signal = AbortSignal.any([outer, AbortSignal.timeout(settings.timeoutMs)]);
      signal.throwIfAborted();
      if (id === "local") {
        const input = challenge.captchaVersion === 3 ? { version: 3 as const, gt: challenge.gt, challenge: challenge.challenge }
          : { version: 4 as const, captcha_id: challenge.captchaId, ...(challenge.riskType !== undefined && { risk_type: challenge.riskType }) };
        const engine = await localSolver();
        signal.throwIfAborted();
        const result = await engine.solve(input, signal);
        const proof = normalizeCaptchaProof(result, challenge);
        if (!proof) throw new ProviderFailure("local_invalid_proof");
        return proof;
      }
      const ttocr = config.ttocr;
      const fields = new URLSearchParams({ key: ttocr.key, gt: challenge.captchaVersion === 3 ? challenge.gt : challenge.captchaId,
        itemid: challenge.captchaVersion === 3 ? ttocr.itemid : ttocr.itemidV4, referer: ttocr.referer });
      if (challenge.captchaVersion === 3) fields.set("challenge", challenge.challenge);
      else if (challenge.riskType !== undefined) fields.set("ts_risktype", challenge.riskType);
      const submit = await form(ttocr.api, fields, signal);
      if (Number(submit.status) !== 1 || !field(String(submit.resultid ?? ""), 256)) classify(submit);
      const resultid = String(submit.resultid), key = `${new URL(ttocr.resultApi).origin}/${resultid}`;
      const deadline = now() + ttocr.timeoutMs;
      while (now() < deadline) {
        signal.throwIfAborted();
        const previous = polls.get(key) ?? Promise.resolve();
        const gate = Promise.withResolvers<void>();
        polls.set(key, gate.promise);
        let result: Record<string, unknown>;
        try {
          let abort: () => void = () => {};
          try {
            await Promise.race([previous, new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            })]);
          } finally { signal.removeEventListener("abort", abort); }
          signal.throwIfAborted();
          await wait(ttocr.pollMs, signal);
          signal.throwIfAborted();
          if (now() >= deadline) throw new ProviderFailure("ttocr_timeout");
          result = await form(ttocr.resultApi, new URLSearchParams({ key: ttocr.key, resultid }), signal);
        } finally {
          gate.resolve();
          if (polls.get(key) === gate.promise) polls.delete(key);
        }
        signal.throwIfAborted();
        if (Number(result.status) === 1) {
          const proof = normalizeCaptchaProof(result.data, challenge);
          if (!proof) throw new ProviderFailure("ttocr_invalid_proof");
          return proof;
        }
        if (terminal.has(Number(result.status))) classify(result);
      }
      throw new ProviderFailure("ttocr_timeout");
    },
  };
}
