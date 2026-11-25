import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { randomBytes } from "node:crypto";
import { createVerificationHandler } from "../../vendor/gt-manual/lib/server.js";

export type ManualCaptchaChallenge =
  | { readonly captchaVersion: 3; readonly gt: string; readonly challenge: string;
    readonly new_captcha?: boolean | 0 | 1; readonly success?: boolean | 0 | 1 }
  | { readonly captchaVersion: 4; readonly captchaId: string; readonly riskType?: string; readonly userInfo?: string };

export type ManualCaptchaProof =
  | { readonly challenge: string; readonly validate: string; readonly seccode: string }
  | { readonly captchaVersion: 4; readonly captchaId: string; readonly lotNumber: string;
    readonly captchaOutput: string; readonly passToken: string; readonly genTime: string };

export interface ManualCaptchaFailure {
  readonly ok: false;
  readonly reason: "manual_closed" | "manual_sdk_error" | "manual_invalid_result" | "manual_submission_failed" | "manual_expired";
  readonly captchaVersion: 3 | 4;
}

declare const ticketBrand: unique symbol;
export interface ManualCaptchaTicket {
  readonly [ticketBrand]: true;
}

export interface ManualCaptchaRegistration {
  readonly link: string;
  readonly expiresAt: number;
  readonly ticket: ManualCaptchaTicket;
}

export type ManualCaptchaResult =
  | { readonly status: "pending" | "unavailable" }
  | { readonly status: "complete"; readonly result: ManualCaptchaProof | ManualCaptchaFailure };

export interface ManualCaptchaRelayOptions {
  readonly publicUrl: string;
  readonly basePath?: string;
  readonly ttlMs?: number;
  readonly resultTtlMs?: number;
  readonly maxTasks?: number;
  readonly now?: () => number;
}

export const manualCaptchaBasePath = "/captcha/manual";
const bodyLimit = 16 * 1024;
const bodyDeadline = 5_000;
const idPattern = /^[A-Za-z0-9_-]{32}$/u;
const pageRoute = /^\/GTest\/[A-Za-z0-9_-]{32}$/u;
const claimRoute = /^\/GTest\/register\/[A-Za-z0-9_-]{32}$/u;
const submitRoute = /^\/GTest\/(?:validate|fail)\/[A-Za-z0-9_-]{32}$/u;
const assets = new Set(["/verify.js", "/verify.css"]);
const protectedHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

function publicBase(raw: string): URL {
  const match = typeof raw === "string" && /^https?:\/\/[^\s/?#@\\]+(\/[^\s?#\\]*)?$/iu.exec(raw);
  if (!match || match[0] !== raw) throw new Error($t("lib.captcha.manual-relay.text_1d31ea95e7"));
  const parsed = URL.parse(raw);
  if (!parsed || parsed.username || parsed.password || parsed.port === "0" ||
      (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) {
    throw new Error($t("lib.captcha.manual-relay.text_450e8f174c"));
  }
  const path = match[1]?.replace(/\/$/u, "") ?? "";
  try {
    if (path && path.slice(1).split("/").some((segment) => {
      const decoded = decodeURIComponent(segment);
      return !decoded || decoded === "." || decoded === ".." || /[/\\\u0000-\u001f\u007f]/u.test(decoded);
    })) throw new Error();
    // GT-Manual uses the path in both HTML attributes and string replacement templates.
    if (!/^[\w/.~@+!()'*,;=:%-]+$/u.test(parsed.pathname)) throw new Error();
  } catch {
    throw new Error($t("lib.captcha.manual-relay.text_f84f81a7d8"));
  }
  return parsed;
}

function positive(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error($t("lib.captcha.manual-relay.text_b76fedd39a"));
  return value;
}

function publicError(status: number): Response {
  return new Response(null, { status, headers: protectedHeaders });
}

async function readSubmission(request: Request, closed: AbortSignal, scope?: AbortSignal): Promise<{ body: object } | { status: number }> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { status: 415 };
  if (!request.body || request.bodyUsed || request.body.locked) return { status: 400 };
  const length = request.headers.get("Content-Length");
  if (length !== null && !/^\d+$/u.test(length)) return { status: 400 };
  if (length !== null && Number(length) > bodyLimit) {
    void request.body.cancel().catch(() => undefined);
    return { status: 413 };
  }

  const timeout = AbortSignal.timeout(bodyDeadline);
  const signal = AbortSignal.any([request.signal, closed, timeout, ...(scope ? [scope] : [])]);
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const abortStatus = () => closed.aborted ? 503 : scope?.aborted ? 404 : timeout.aborted ? 408 : 400;
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let raw = "";
  try {
    for (;;) {
      if (signal.aborted) return { status: abortStatus() };
      const { done, value } = await reader.read();
      if (signal.aborted) return { status: abortStatus() };
      if (done) break;
      bytes += value.byteLength;
      if (bytes > bodyLimit) return { status: 413 };
      raw += decoder.decode(value, { stream: true });
    }
    const body: unknown = JSON.parse(raw + decoder.decode());
    return body && typeof body === "object" && !Array.isArray(body) ? { body } : { status: 400 };
  } catch {
    return { status: signal.aborted ? abortStatus() : 400 };
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export function createManualCaptchaRelay({
  publicUrl, basePath = manualCaptchaBasePath, ttlMs = 180_000, resultTtlMs = 30_000, maxTasks = 1000, now,
}: ManualCaptchaRelayOptions) {
  const origin = publicBase(publicUrl);
  if (!/^(?:\/[A-Za-z0-9_-]+)+$/u.test(basePath) || basePath.length > 160) throw new Error($t("lib.captcha.manual-relay.text_4f40010b8c"));
  const publicPath = origin.pathname.replace(/\/$/u, "") + basePath;
  const registerKey = randomBytes(32).toString("base64url");
  const stopped = new AbortController();
  const vendorOptions = { now, config: {
    basePath: publicPath, publicAddress: origin.origin, allowedOrigins: [origin.origin], registerKey,
    ttlMs: positive(ttlMs, 3_600_000), resultTtlMs: positive(resultTtlMs, 3_600_000), maxTasks: positive(maxTasks, 1000),
  } };
  const handler = createVerificationHandler(vendorOptions);
  let tickets = new WeakMap<ManualCaptchaTicket, string>();
  const scopes = new Map<string, { signal: AbortSignal; expiresAt: number }>();
  const clock = now ?? Date.now;

  async function dispatch(method: string, path: string, body?: object): Promise<Response> {
    const headers = new Headers(protectedHeaders);
    let status = 500;
    let payload: string | Uint8Array<ArrayBuffer> | null = null;
    const reply = {
      headersSent: false,
      setHeader(name: string, value: string) { headers.set(name, value); },
      writeHead(code: number, fields: Record<string, string>) {
        status = code;
        for (const [name, value] of Object.entries(fields)) headers.set(name, value);
        this.headersSent = true;
      },
      end(value?: string | Uint8Array) {
        if (value !== undefined) payload = typeof value === "string" ? value : new Uint8Array(value);
      },
    };
    await handler({ method, url: publicPath + path, headers: { host: origin.host, origin: origin.origin,
      ...(body && { "content-type": "application/json" }) }, socket: { encrypted: origin.protocol === "https:" }, body }, reply);
    return new Response(payload, { status, headers });
  }

  async function handlePublic(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== basePath && !url.pathname.startsWith(basePath + "/")) return;
    const path = url.pathname.slice(basePath.length);
    const get = request.method === "GET" && (assets.has(path) || pageRoute.test(path) || claimRoute.test(path));
    const post = request.method === "POST" && submitRoute.test(path);
    const authority = request.headers.get("Host") ?? url.host;
    // A reverse proxy keeps the configured Host and may use plain HTTP to the listener.
    // Never derive the public URL or trusted Origin from forwarded headers.
    if ((!get && !post) || (url.protocol !== "http:" && url.protocol !== "https:") || url.search ||
        authority.toLowerCase() !== origin.host || url.host !== origin.host) return publicError(404);
    if (stopped.signal.aborted) return publicError(503);
    const scope = scopes.get(path.slice(path.lastIndexOf("/") + 1))?.signal;
    if (scope?.aborted) return publicError(404);
    const suppliedOrigin = request.headers.get("Origin");
    if ((post || suppliedOrigin !== null) && suppliedOrigin !== origin.origin) return publicError(403);
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (claimRoute.test(path) && fetchSite !== null && fetchSite !== "same-origin") return publicError(403);
    if (request.signal.aborted) return publicError(400);
    if (!post) {
      const response = await dispatch("GET", path);
      return scope?.aborted ? publicError(404) : response;
    }
    const submission = await readSubmission(request, stopped.signal, scope);
    if ("status" in submission) return publicError(submission.status);
    if (stopped.signal.aborted) return publicError(503);
    if (request.signal.aborted) return publicError(400);
    if (scope?.aborted) return publicError(404);
    const response = await dispatch("POST", path, submission.body);
    return stopped.signal.aborted ? publicError(503) : scope?.aborted ? publicError(404) : response;
  }

  async function register(challenge: ManualCaptchaChallenge, signal?: AbortSignal): Promise<ManualCaptchaRegistration | undefined> {
    if (stopped.signal.aborted || signal?.aborted) return;
    const time = clock();
    for (const [id, scope] of scopes) if (scope.expiresAt <= time) scopes.delete(id);
    const response = await dispatch("POST", "/GTest/register", { ...challenge, key: registerKey });
    if (stopped.signal.aborted) {
      handler.close();
      return;
    }
    if (!response.ok) return;
    const { data } = await response.json() as { data: { link: string; expires_at: number } };
    if (stopped.signal.aborted) return;
    const id = data.link.slice(data.link.lastIndexOf("/") + 1);
    if (!idPattern.test(id)) return;
    if (signal) {
      scopes.set(id, { signal, expiresAt: data.expires_at });
      if (signal.aborted) return;
    }
    const ticket = Object.freeze({}) as ManualCaptchaTicket;
    tickets.set(ticket, id);
    return { link: `${origin.origin}${publicPath}/GTest/${id}`, expiresAt: data.expires_at, ticket };
  }

  async function readResult(ticket: ManualCaptchaTicket): Promise<ManualCaptchaResult> {
    const id = tickets.get(ticket);
    if (!id || stopped.signal.aborted || scopes.get(id)?.signal.aborted) return { status: "unavailable" };
    const response = await dispatch("GET", `/GTest/validate/${id}`);
    if (stopped.signal.aborted || scopes.get(id)?.signal.aborted) return { status: "unavailable" };
    if (!response.ok) {
      tickets.delete(ticket);
      return { status: "unavailable" };
    }
    const { data } = await response.json() as { data: ManualCaptchaProof | ManualCaptchaFailure | Record<string, never> };
    if (stopped.signal.aborted) return { status: "unavailable" };
    if (!Object.keys(data).length) return { status: "pending" };
    tickets.delete(ticket);
    return { status: "complete", result: data as ManualCaptchaProof | ManualCaptchaFailure };
  }

  return {
    handlePublic, register, readResult,
    close() {
      if (stopped.signal.aborted) return;
      stopped.abort();
      tickets = new WeakMap();
      scopes.clear();
      handler.close();
    },
  };
}
