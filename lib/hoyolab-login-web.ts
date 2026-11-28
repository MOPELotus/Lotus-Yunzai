import { createHash, randomBytes } from "node:crypto";
import { createProfileStore, MAX_PROFILE_ID, ProfileError, type ProfileLoginSlot } from "@lotus-yunzai/account";
import { createHoYoLabLogin, fetchHoYoLabLoginRoles, HoYoLabLoginError, type HoYoLabLoginStep } from "../packages/hoyo-client/hoyolab-login.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { ownOperationSession } from "./own-operation-session.ts";
import type { CommandModule } from "./commands.ts";
import { createTranslator } from "../packages/i18n/index.ts";
import catalog from "../i18n/zh-CN.json";
const $t = createTranslator("core", catalog.messages);
const t = (key: string, values?: Record<string, string | number>) => $t(`lib.hoyolab-login-web.${key}`, values);
const command = /^#(取消)?(?:国际服|海外服)(?:登录|登陆)([1-9]\d{0,2})?$/u;
export function isHoYoLabLoginCommand(message: string) { return command.test(message); }
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const lifetime = 10 * 60_000;
interface Session {
  readonly slot: ProfileLoginSlot; readonly scope: string; readonly group?: number;
  readonly login: ReturnType<ReturnType<typeof createHoYoLabLogin>["start"]>;
  readonly controller: AbortController; readonly signal: AbortSignal; readonly expires: number;
  readonly detach: () => void;
  busy: boolean; attempts: number; state: "password" | "captcha" | "email" | "saving";
  complete?: Extract<HoYoLabLoginStep, { state: "complete" }>["credentials"];
  lastEmail: number;
}
export function createHoYoLabLoginWeb({ directory, signal, publicBase, transport, assetDirectory, now = Date.now,
  onLogin, }: {
  readonly directory?: string; readonly signal: AbortSignal; readonly publicBase: () => URL | undefined;
  readonly transport: HoyoTransport; readonly assetDirectory: URL;
  readonly now?: () => number;
  readonly onLogin?: (qq: string, profileId: number, revision: string) => Promise<void>;
}) {
  const profiles = createProfileStore(directory), client = createHoYoLabLogin(transport);
  const sessions = new Map<string, Session>();
  const mount = "/hoyolab-login";
  function remove(key: string) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key); session.detach(); session.controller.abort(); session.login.destroy(); session.complete = undefined;
  }
  function prune() {
    for (const [key, session] of sessions) if (session.expires <= now() || session.signal.aborted) remove(key);
  }
  const cleanup = setInterval(prune, 30_000); cleanup.unref();
  const close = () => { clearInterval(cleanup); for (const key of sessions.keys()) remove(key); };
  signal.addEventListener("abort", close, { once: true });
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": "default-src 'none'; script-src 'self' https://static.geetest.com https://static.geevisit.com https://*.geetest.com https://*.captchami.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.geetest.com https://*.geevisit.com https://*.captchami.com; connect-src 'self' https://*.geetest.com https://*.geevisit.com https://*.captchami.com; frame-src https://*.geetest.com https://*.geevisit.com https://*.captchami.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  const error = (key: string, status = 400, values?: Record<string, string | number>) => json({ error: t(key, values) }, status);
  function secure(url: URL) { return url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }
  const commands: CommandModule = {
    name: "@lotus-yunzai/hoyolab-login", commands: {},
    async fallback(_message, context) {
      const match = command.exec(context.normalizedMessage);
      if (!match || signal.aborted) return;
      const operation = ownOperationSession(context);
      if (!operation) return t("ownOnly");
      const id = Number(match[2] ?? 1);
      if (id > MAX_PROFILE_ID) return t("invalid");
      prune();
      for (const [key, session] of sessions) if (session.slot.qq === String(operation.user) && session.slot.profileId === id) {
        if (match[1] && session.scope === operation.scope) { remove(key); return t("cancelled"); }
        return t("busy");
      }
      if (match[1]) return t("cancelled");
      const base = publicBase();
      if (!base) return t("unavailable");
      if (!secure(base)) return t("secure");
      if (sessions.size >= 256) return t("busy");
      const slot = await profiles.openLoginSlot(String(operation.user), id);
      if (operation.signal.aborted || signal.aborted) return;
      const stored = await profiles.internationalCredentials(slot.qq, id).catch(() => undefined);
      const token = randomBytes(32).toString("base64url"), key = hash(token), controller = new AbortController();
      const abort = () => remove(key);
      const active = AbortSignal.any([signal, operation.signal, controller.signal]);
      operation.signal.addEventListener("abort", abort, { once: true });
      sessions.set(key, { slot, scope: operation.scope, group: operation.group, controller, signal: active,
        detach: () => operation.signal.removeEventListener("abort", abort), login: client.start(stored?.deviceId),
        expires: now() + lifetime, busy: false, attempts: 0, state: "password", lastEmail: 0 });
      const url = new URL(`${mount}/`, base); url.hash = token;
      return t("link", { url: url.href, minutes: 10, id });
    },
  };
  return { commands, mount, close,
    async handle(request: Request, server?: { timeout?(request: Request, seconds: number): void }): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`)) return;
      if (request.method === "POST") server?.timeout?.(request, 120);
      if (signal.aborted) return error("expired", 503);
      if (request.method === "GET") {
        const files: Record<string, [string, string]> = { [mount]: ["index.html", "text/html"], [`${mount}/`]: ["index.html", "text/html"],
          [`${mount}/login.js`]: ["login.js", "text/javascript"], [`${mount}/login.css`]: ["login.css", "text/css"] };
        if (url.pathname === `${mount}/messages`) return json(Object.fromEntries(Object.entries(catalog.messages)
          .filter(([key]) => key.startsWith("lib.hoyolab-login-web.")).map(([key]) => [key.slice("lib.hoyolab-login-web.".length), t(key.slice("lib.hoyolab-login-web.".length))])));
        const entry = files[url.pathname];
        if (!entry) return new Response(null, { status: 404, headers });
        const file = Bun.file(new URL(entry[0], assetDirectory));
        if (!await file.exists()) return error("unavailable", 503);
        return new Response(file, { headers: { ...headers, "Content-Type": `${entry[1]}; charset=utf-8` } });
      }
      if (request.method !== "POST" || !["/password", "/captcha", "/email", "/resend", "/cancel", "/status"].some(path => url.pathname === mount + path)) return new Response(null, { status: 405, headers });
      const origin = request.headers.get("Origin"), base = publicBase();
      if (!origin || !base || !secure(base) || origin !== base.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") return error("invalid", 403);
      if (!/^application\/json(?:;|$)/iu.test(request.headers.get("Content-Type") ?? "")) return error("invalid", 415);
      const token = request.headers.get("Authorization")?.replace(/^Bearer /u, "") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return error("expired", 401);
      prune(); const key = hash(token), session = sessions.get(key);
      if (!session) return error("expired", 401);
      if (session.busy) return error("busy", 409);
      if (url.pathname === `${mount}/cancel`) { remove(key); return json({ state: "cancelled", message: t("cancelled") }); }
      if (url.pathname === `${mount}/status`) return json({ state: session.state, id: session.slot.profileId });
      if (++session.attempts > 20) { remove(key); return error("retryLimit", 429); }
      session.busy = true;
      try {
        const reader = request.body?.getReader(); if (!reader) return error("invalid");
        const chunks: Uint8Array[] = []; let size = 0;
        const bodyDeadline = AbortSignal.any([session.signal, AbortSignal.timeout(10_000)]);
        const cancelBody = () => { void reader.cancel().catch(() => undefined); };
        bodyDeadline.addEventListener("abort", cancelBody, { once: true });
        try {
          while (true) { const part = await reader.read(); if (part.done) break;
            size += part.value.length; if (size > 24 * 1024) { await reader.cancel(); return error("invalid", 413); } chunks.push(part.value); }
        } finally { bodyDeadline.removeEventListener("abort", cancelBody); reader.releaseLock(); }
        bodyDeadline.throwIfAborted();
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) return error("invalid");
        const data = body as Record<string, unknown>;
        await profiles.verifyLoginSlot(session.slot); session.signal.throwIfAborted();
        let step: HoYoLabLoginStep;
        if (session.complete) step = { state: "complete", credentials: session.complete };
        else if (url.pathname === `${mount}/password` && session.state === "password" && typeof data.account === "string" && typeof data.password === "string") {
          step = await session.login.password(data.account, data.password, session.signal);
        } else if (url.pathname === `${mount}/captcha` && session.state === "captcha") step = await session.login.captcha(data.result, session.signal);
        else if (url.pathname === `${mount}/email` && session.state === "email" && typeof data.code === "string") step = await session.login.verifyEmail(data.code, session.signal);
        else if (url.pathname === `${mount}/resend` && session.state === "email") {
          if (now() - session.lastEmail < 60_000) return error("busy", 429);
          session.lastEmail = now(); step = await session.login.resend(session.signal);
        } else return error("invalid");
        await profiles.verifyLoginSlot(session.slot); session.signal.throwIfAborted();
        if (step.state === "complete") {
          session.complete = step.credentials; session.state = "saving";
          const credentials = await client.exchange(step.credentials, session.signal);
          const roles = await fetchHoYoLabLoginRoles(credentials, transport, session.signal);
          await profiles.verifyLoginSlot(session.slot); session.signal.throwIfAborted();
          const saved = await profiles.saveInternationalLogin(session.slot, credentials, roles, session.signal, session.group);
          const { qq, profileId } = session.slot;
          remove(key);
          // Scheduling errors must not turn a committed login into a reported login failure.
          await onLogin?.(qq, profileId, saved.revision).catch(() => undefined);
          return json({ state: "complete", message: t("success", { id: profileId }), id: profileId });
        }
        session.state = step.state;
        if (step.state === "email") session.lastEmail = now();
        return json({ ...step, message: t(step.state === "email" ? "email" : "captchaRequired") });
      } catch (cause) {
        if (session.signal.aborted) return error("expired", 401);
        if (cause instanceof ProfileError) { remove(key); return error("changed", 409); }
        if (cause instanceof HoYoLabLoginError) {
          if (cause.kind === "api") return error("failed", 400, { code: cause.code ?? 0 });
          if (cause.kind === "input") return error("invalid");
        }
        return error(cause instanceof SyntaxError ? "invalid" : "network", 400);
      } finally { session.busy = false; }
    },
  };
}
