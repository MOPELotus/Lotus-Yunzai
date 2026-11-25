import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { createHash, randomInt } from "node:crypto";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";

export interface PassportQrDevice {
  readonly id: string;
  readonly fp?: string;
  readonly name?: string;
  readonly model?: string;
  readonly androidVersion?: string;
}

export interface PassportQrSession {
  readonly url: string;
  readonly expiresAt?: number;
}

export interface PassportQrCredentials {
  readonly stuid: string;
  readonly stoken: string;
  readonly mid?: string;
}

export type PassportQrStatus =
  | { readonly status: "created" | "scanned" | "expired" | "cancelled" }
  | { readonly status: "confirmed"; readonly credentials: PassportQrCredentials };

export interface PassportQrOptions {
  readonly signal?: AbortSignal;
}

export class PassportQrError extends HoyoRequestError {
  constructor(
    readonly reason: "invalid-device" | "invalid-session" | "busy" | "aborted" | "transport" | "response" |
      "expired" | "cancelled" | "risk" | "realname" | "rate-limited",
    code: HoyoRequestError["code"],
    message: string,
    status?: number,
    retcode?: number,
  ) {
    super(code, message, status, retcode);
  }
}

type Json = Record<string, unknown>;
type SessionData = { readonly ticket: string; readonly device: PassportQrDevice; polling: boolean };
const passportOrigin = "https://passport-api.mihoyo.com";
const passportPath = "/account/ma-cn-passport/app/";
const protocol = { appId: "bll8iq97cem8", version: "2.102.1", sdk: "1.3.1.2", salt: "JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS" };
const ticketPattern = /^[A-Za-z0-9_-]{1,256}$/u;
const secretPattern = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/u;
const riskCodes = new Set([-3101, 1034, 10035, 10041]);
const maxResponseBytes = 32 * 1024;

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function responseError(message: string): never {
  throw new PassportQrError("response", "response", message);
}

function retcodeOf(value: unknown): number | undefined {
  const normalized = typeof value === "string" && /^-?\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof normalized === "number" && Number.isSafeInteger(normalized)) return normalized;
}

function checkedDevice({ id, fp, name, model, androidVersion }: PassportQrDevice): PassportQrDevice {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
    throw new PassportQrError("invalid-device", "invalid-input", $t("passport-qr.text_9caf6b7d06"));
  }
  const headerValue = (value: string | undefined) => typeof value === "string" && /^[\x20-\x7E]{1,128}$/u.test(value) ? value : undefined;
  return { id, fp: headerValue(fp), name: headerValue(name), model: headerValue(model), androidVersion: headerValue(androidVersion) };
}

export function passportAppHeaders(device: PassportQrDevice, body: string, sdkVersion = protocol.sdk): Headers {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomInt(100001, 200000);
  const hash = createHash("md5").update(`salt=${protocol.salt}&t=${timestamp}&r=${nonce}&b=${body}&q=`).digest("hex");
  const headers = new Headers({
    Accept: "application/json", "Content-Type": "application/json",
    "User-Agent": "okhttp/4.8.0", "x-rpc-app_id": protocol.appId, "x-rpc-client_type": "2",
    "x-rpc-game_biz": "bbs_cn", "x-rpc-app_version": protocol.version, "x-rpc-sdk_version": sdkVersion, "x-rpc-aigis": "",
    "x-rpc-channel": "appstore", "x-rpc-device_id": device.id, "x-rpc-sys_version": device.androidVersion || "11",
    DS: `${timestamp},${nonce},${hash}`,
  });
  const deviceHeader = (value: string) => /^[\x20-\x7E]+$/u.test(value) ? value : encodeURIComponent(value.toWellFormed());
  if (device.fp) headers.set("x-rpc-device_fp", deviceHeader(device.fp));
  if (device.name) headers.set("x-rpc-device_name", deviceHeader(device.name));
  if (device.model) headers.set("x-rpc-device_model", deviceHeader(device.model));
  return headers;
}

async function readPayload(response: Response): Promise<Json | undefined> {
  if (!response.body) return;
  if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
    await response.body.cancel().catch(() => undefined);
    responseError($t("passport-qr.text_a59425274e"));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) responseError($t("passport-qr.text_a59425274e"));
      text += decoder.decode(next.value, { stream: true });
    }
    return object(JSON.parse(text + decoder.decode()));
  } catch (error) {
    if (error instanceof PassportQrError) throw error;
    return;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function aborted(): never {
  throw new PassportQrError("aborted", "transport", $t("passport-qr.text_b8ee8a6b89"));
}

function responseFailure(status: number, retcode?: number): never {
  if (retcode === -3501) throw new PassportQrError("expired", "api", $t("passport-qr.text_e54134365d"), status, retcode);
  if (retcode === -3505) throw new PassportQrError("cancelled", "api", $t("passport-qr.text_4fa98861ab"), status, retcode);
  throw new PassportQrError("response", status === 200 ? "api" : "http", $t("passport-qr.text_64800e273b"), status, retcode);
}

function loginLink(data: Json): { session: PassportQrSession; ticket: string } {
  const raw = data.url;
  const url = typeof raw === "string" && raw.length <= 2048 && !/[\x00-\x20\x7F]/u.test(raw) ? URL.parse(raw) : null;
  if (!url || url.origin !== "https://user.mihoyo.com" || url.pathname !== "/login-platform/mobile.html" ||
      url.username || url.password || (url.hash && url.hash !== "#/login/qr")) {
    responseError($t("passport-qr.text_2f0d652824"));
  }
  const tickets = [...url.searchParams.getAll("tk"), ...url.searchParams.getAll("ticket")];
  const ticket = data.ticket ?? tickets[0];
  if (typeof ticket !== "string" || !ticketPattern.test(ticket) || tickets.length !== 1 || tickets[0] !== ticket) {
    responseError($t("passport-qr.text_4abb92c8fb"));
  }
  const tokenTypes = url.searchParams.getAll("token_types");
  if (tokenTypes.length > 1 || (tokenTypes.length === 1 && tokenTypes[0] !== "1")) {
    responseError($t("passport-qr.text_682fecd79d"));
  }
  const dates = url.searchParams.getAll("expire");
  if (dates.length > 1 || (dates.length && !/^\d{10}$/u.test(dates[0]!))) responseError($t("passport-qr.text_de9ca97ec8"));
  const expiresAt = dates.length ? Number(dates[0]) * 1000 : undefined;
  if (expiresAt !== undefined && expiresAt <= Date.now()) responseFailure(200, -3501);
  return { session: Object.freeze({ url: url.href, ...(expiresAt === undefined ? {} : { expiresAt }) }), ticket };
}

function uidOf(value: unknown): string | undefined {
  const uid = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof uid === "string" && /^[1-9]\d{0,18}$/u.test(uid)) return uid;
}

function loginCredentials(data: Json): PassportQrCredentials {
  const user = object(data.user_info);
  const ids = [user?.aid, user?.uid, user?.account_id].filter((value) => value !== undefined && value !== null && value !== "").map(uidOf);
  const stuid = ids[0];
  if (!stuid || ids.some((id) => id !== stuid)) responseError($t("passport-qr.text_a729888f25"));
  if (!Array.isArray(data.tokens)) responseError($t("passport-qr.text_4215c2a56e"));
  const matching = new Set<string>();
  for (const item of data.tokens) {
    const row = object(item);
    if (!row) continue;
    const named = row.name === "stoken" || row.name === "stoken_v2";
    const typed = row.token_type === 1 || row.token_type === "1";
    if (!named && !typed) continue;
    const contradicts = (named && row.token_type !== undefined && !typed) ||
      (typed && typeof row.name === "string" && /^(?:ltoken|cookie_token|game_token)(?:_v2)?$/u.test(row.name));
    if (contradicts || typeof row.token !== "string" || !secretPattern.test(row.token)) {
      responseError($t("passport-qr.text_fbec16341d"));
    }
    matching.add(row.token);
  }
  const stoken = matching.values().next().value;
  if (!stoken || matching.size !== 1) responseError($t("passport-qr.text_5e8371eeda"));
  const mid = user?.mid;
  const checkedMid = typeof mid === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(mid) ? mid : undefined;
  if ((stoken.startsWith("v2_") && !checkedMid) || (mid !== undefined && mid !== null && mid !== "" && !checkedMid)) {
    responseError($t("passport-qr.text_92ec519f4a"));
  }
  return { stuid, stoken, ...(checkedMid ? { mid: checkedMid } : {}) };
}

function passportFlag(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && value !== false &&
    value !== 0 && value !== "0" && value !== "false";
}

export function createPassportQr(transport: HoyoTransport) {
  const sessions = new WeakMap<PassportQrSession, SessionData>();

  async function request(path: "createQRLogin" | "queryQRLoginStatus", device: PassportQrDevice, body: string, signal?: AbortSignal) {
    if (signal?.aborted) aborted();
    const timeout = AbortSignal.timeout(20_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await transport(new URL(passportPath + path, passportOrigin), {
        method: "POST", redirect: "error", credentials: "omit", proxy: false, body,
        headers: passportAppHeaders(device, body), signal: deadline,
      });
    } catch {
      if (signal?.aborted) aborted();
      throw new PassportQrError("transport", "transport", $t("passport-qr.text_66ff360cb8"));
    }
    if (deadline.aborted || response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      if (signal?.aborted) aborted();
      if (timeout.aborted) throw new PassportQrError("transport", "transport", $t("passport-qr.text_60ada1dd3e"));
      throw new PassportQrError("rate-limited", "http", $t("passport-qr.text_884cb3d5e5"), 429);
    }
    const challenge = response.headers.get("x-rpc-aigis")?.trim();
    if (challenge && challenge !== "{}") {
      await response.body?.cancel().catch(() => undefined);
      throw new PassportQrError("risk", "api", $t("passport-qr.text_4cd4557440"), response.status);
    }
    const payload = await readPayload(response);
    if (signal?.aborted) aborted();
    if (timeout.aborted) throw new PassportQrError("transport", "transport", $t("passport-qr.text_60ada1dd3e"));
    const retcode = retcodeOf(payload?.retcode);
    const data = object(payload?.data);
    const message = typeof payload?.message === "string" ? payload.message : "";
    if (passportFlag(data?.need_realperson) || passportFlag(object(data?.realname_info)?.required) ||
        (retcode !== 0 && /实名|real[- ]?name/iu.test(message))) {
      throw new PassportQrError("realname", "api", $t("passport-qr.text_bcc38b2d51"), response.status, retcode);
    }
    if ((retcode !== undefined && riskCodes.has(retcode)) || (retcode !== 0 && /验证码|风控|captcha|challenge/iu.test(message))) {
      throw new PassportQrError("risk", "api", $t("passport-qr.text_4cd4557440"), response.status, retcode);
    }
    if (retcode !== 0 && /频繁|rate limit|too frequent/iu.test(message)) {
      throw new PassportQrError("rate-limited", "api", $t("passport-qr.text_884cb3d5e5"), response.status, retcode);
    }
    if (!response.ok || (retcode !== 0 && retcode !== -3501 && retcode !== -3505)) responseFailure(response.status, retcode);
    return { data, retcode, status: response.status };
  }

  return {
    async create(device: PassportQrDevice, { signal }: PassportQrOptions = {}): Promise<PassportQrSession> {
      const savedDevice = checkedDevice(device);
      const { data, retcode, status } = await request("createQRLogin", savedDevice, "{}", signal);
      if (retcode !== 0) responseFailure(status, retcode);
      if (!data) responseError($t("passport-qr.text_fddde555ea"));
      const { session, ticket } = loginLink(data);
      sessions.set(session, { ticket, device: savedDevice, polling: false });
      return session;
    },
    async poll(session: PassportQrSession, { signal }: PassportQrOptions = {}): Promise<PassportQrStatus> {
      const current = sessions.get(session);
      if (!current) throw new PassportQrError("invalid-session", "invalid-input", $t("passport-qr.text_57613478ec"));
      if (current.polling) throw new PassportQrError("busy", "invalid-input", $t("passport-qr.text_fb32829c08"));
      current.polling = true;
      try {
        if (signal?.aborted) aborted();
        if (session.expiresAt !== undefined && session.expiresAt <= Date.now()) {
          sessions.delete(session);
          return { status: "expired" };
        }
        const result = await request("queryQRLoginStatus", current.device, JSON.stringify({ ticket: current.ticket }), signal);
        const { status: primary, stat: alternate } = result.data ?? {};
        if (primary !== undefined && alternate !== undefined && primary !== alternate) {
          responseError($t("passport-qr.text_3780a74cd0"));
        }
        const status = primary ?? alternate;
        if (result.retcode === 0 && status === "Created") return { status: "created" };
        if (result.retcode === 0 && (status === "Scanned" || status === "ScannedWaitingConfirmation")) return { status: "scanned" };
        sessions.delete(session);
        if (result.retcode === -3501 || status === "Expired") return { status: "expired" };
        if (result.retcode === -3505 || status === "Cancelled") return { status: "cancelled" };
        if (result.retcode === 0 && result.data && status === "Confirmed") {
          return { status: "confirmed", credentials: loginCredentials(result.data) };
        }
        responseError($t("passport-qr.text_f602a6e540"));
      } catch (error) {
        sessions.delete(session);
        throw error;
      } finally {
        current.polling = false;
      }
    },
  };
}
