import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { gachaAuthHeaders, gachaStokenCookie } from "./gacha-auth-request.ts";
import { resolveZzzGachaLinkRole } from "./zzz-gacha-link.ts";

const authorizationEndpoint = "https://api-takumi.mihoyo.com/binding/api/genAuthKey";
const historyEndpoint = "https://public-operation-common.mihoyo.com/common/gacha_record/api/getGachaLog";
const authApp = "webview_gacha";
const gameBiz = "nap_cn";
const expiredCodes = new Set([-100, 10001, 10101, 10102, 10103]);
const riskCodes = new Set([1034, 10035, 10041]);
const maxResponseBytes = 32 * 1024;

export interface ZzzGachaAuthKey {
  readonly uid: string;
  readonly region: "prod_gf_cn" | "prod_qd_cn";
  readonly gameBiz: typeof gameBiz;
  readonly url: URL;
}

class ZzzGachaAuthKeyError extends HoyoRequestError {
  constructor(retcode: number) {
    super("api", $t("zzz-gacha-auth.text_9877c3f652"), undefined, retcode);
  }
}

export function isZzzGachaAuthExpired(error: unknown): boolean {
  return error instanceof ZzzGachaAuthKeyError;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new HoyoRequestError("response", $t("zzz-gacha-auth.text_41c31f1d4c"));
}

async function readCredentialResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    invalidResponse();
  }
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) invalidResponse();
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } catch (error) {
    if (signal.aborted) throw new HoyoRequestError("transport", $t("zzz-gacha-auth.text_01e8e3c81f"));
    if (error instanceof HoyoRequestError) throw error;
    invalidResponse();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function signedLink(authkey: string, region: ZzzGachaAuthKey["region"]) {
  const url = new URL(historyEndpoint);
  url.search = new URLSearchParams({
    authkey_ver: "1", sign_type: "2", auth_appid: authApp, init_log_gacha_type: "2001", init_log_gacha_base_type: "2",
    gacha_id: "2c1f5692fdfbb733a08733f9eb69d32aed1d37", timestamp: String(Math.floor(Date.now() / 1000)),
    lang: "zh-cn", device_type: "mobile", plat_type: "ios", region, authkey, game_biz: gameBiz,
    gacha_type: "2001", real_gacha_type: "2", page: "1", size: "20", end_id: "0",
  }).toString();
  return url;
}

export async function readZzzGachaAuthKey(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal } = {}, verifyProfile?: () => Promise<void>): Promise<ZzzGachaAuthKey> {
  const { uid, region } = resolveZzzGachaLinkRole(source.role);
  if (source.game !== "zzz" || (region !== "prod_gf_cn" && region !== "prod_qd_cn")) {
    throw new HoyoRequestError("invalid-input", $t("zzz-gacha-auth.text_4ee30b6ced"));
  }
  const cookie = gachaStokenCookie(source, $t("zzz-gacha-auth.text_b1110352c9"));
  let headers: Headers;
  try {
    headers = gachaAuthHeaders(cookie, source);
    headers.set("Host", "api-takumi.mihoyo.com");
  } catch {
    throw new HoyoRequestError("invalid-input", $t("zzz-gacha-auth.text_a99ef177b3"));
  }

  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("zzz-gacha-auth.text_5b56d34df4"));
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("zzz-gacha-auth.text_5b56d34df4"));
  }

  await guard();
  const timeout = AbortSignal.timeout(20_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(new URL(authorizationEndpoint), {
      method: "POST", headers, body: JSON.stringify({ auth_appid: authApp, game_biz: gameBiz, game_uid: Number(uid), region }),
      redirect: "error", credentials: "omit", signal: deadline,
    });
  } catch {
    await guard();
    throw new HoyoRequestError("transport", $t("zzz-gacha-auth.text_dbb3884f0c"));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    await guard();
    throw new HoyoRequestError("http", $t("zzz-gacha-auth.text_5306a4316c"), response.status);
  }
  const payload = await readCredentialResponse(response, deadline);
  await guard();
  const rawCode = record(payload) ? payload.retcode : undefined;
  const retcode = typeof rawCode === "string" && /^-?\d{1,10}$/u.test(rawCode) ? Number(rawCode) : rawCode;
  if (!record(payload) || typeof retcode !== "number" || !Number.isSafeInteger(retcode)) invalidResponse();
  if (expiredCodes.has(retcode)) throw new ZzzGachaAuthKeyError(retcode);
  if (riskCodes.has(retcode)) {
    throw new HoyoRequestError("api", $t("zzz-gacha-auth.text_6e0b1412d9"), response.status, retcode);
  }
  if (retcode !== 0) throw new HoyoRequestError("api", $t("zzz-gacha-auth.text_ae9724debe"), response.status, retcode);
  const credential = payload.data;
  if (!record(credential)) invalidResponse();
  const { authkey } = credential;
  if (typeof authkey !== "string" || !/^[\x21-\x7E]{1,4096}$/u.test(authkey) ||
      (credential.game_uid !== undefined && credential.game_uid !== uid && credential.game_uid !== Number(uid)) ||
      (credential.region !== undefined && credential.region !== region) ||
      (credential.game_biz !== undefined && credential.game_biz !== gameBiz) ||
      (credential.auth_appid !== undefined && credential.auth_appid !== authApp) ||
      (credential.authkey_ver !== undefined && credential.authkey_ver !== 1 && credential.authkey_ver !== "1") ||
      (credential.sign_type !== undefined && credential.sign_type !== 2 && credential.sign_type !== "2")) {
    invalidResponse();
  }
  return { uid, region, gameBiz, url: signedLink(authkey, region) };
}
