import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandModule } from "./commands.ts";
import { readPanelJson } from "./panel.ts";
import { panelPublicPage } from "./server.ts";

const cookieName = "lotus_panel";
const credential = /^[A-Za-z0-9_-]{43}$/u;
const headers = { "Cache-Control": "no-store" };
const loginCommand = /^#?(?:管理面板|配置面板)$/u;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const response = (status: number) => new Response(null, { status, headers });

type Kind = "ticket" | "session";
interface Owner { bot: number; user: number }
interface Options {
  readonly databasePath: string;
  readonly publicBase: () => URL | undefined;
  readonly isOwner: (bot: number, user: number) => boolean;
  readonly signal: AbortSignal;
  readonly config: unknown;
  readonly readLoginConfig?: () => Promise<unknown>;
  readonly now?: () => number;
}

function duration(config: unknown, key: string, unit: number, fallback: number) {
  const value = config && typeof config === "object" && key in config ? (config as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value * unit) && value * unit >= 1000 ? value : fallback;
}

export function panelOwnerLifetimes(config: unknown) {
  return {
    ticketMinutes: duration(config, "panel_ticket_minutes", 60_000, 10),
    sessionHours: duration(config, "panel_session_hours", 3_600_000, 24),
  };
}

function browserToken(request: Request) {
  const values = (request.headers.get("Cookie") ?? "").split(";").map(part => part.trim())
    .filter(part => part.startsWith(`${cookieName}=`));
  const value = values.length === 1 ? values[0]?.slice(cookieName.length + 1) : undefined;
  return value && credential.test(value) ? value : undefined;
}

export function createPanelOwnerSession({ databasePath, publicBase, isOwner, signal, config, readLoginConfig, now = Date.now }: Options) {
  const initialLifetimes = panelOwnerLifetimes(config);
  const lifetimes = async () => readLoginConfig ? panelOwnerLifetimes(await readLoginConfig()) : initialLifetimes;
  let db: Database | undefined;

  const page = () => panelPublicPage(publicBase());

  function database() {
    signal.throwIfAborted();
    if (db) return db;
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    const connection = new Database(databasePath, { create: true, strict: true });
    try {
      chmodSync(databasePath, 0o600);
      connection.exec(`PRAGMA busy_timeout = 3000;
        CREATE TABLE IF NOT EXISTS credentials (
          hash TEXT PRIMARY KEY, kind TEXT NOT NULL, bot INTEGER NOT NULL, user INTEGER NOT NULL, expiresAt INTEGER NOT NULL
        ) STRICT;`);
      return db = connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  function lookup(key: string, kind: Kind) {
    return database().query<Owner, [string, Kind, number]>(
      "SELECT bot, user FROM credentials WHERE hash = ? AND kind = ? AND expiresAt > ?",
    ).get(digest(key), kind, now());
  }
  function insert(key: string, kind: Kind, owner: Owner, lifetime: number) {
    database().run("INSERT INTO credentials VALUES (?, ?, ?, ?, ?)",
      [digest(key), kind, owner.bot, owner.user, Math.min(Number.MAX_SAFE_INTEGER, now() + lifetime)]);
  }
  function remove(key: string, kind: Kind) {
    database().run("DELETE FROM credentials WHERE hash = ? AND kind = ?", [digest(key), kind]);
  }
  function browserResponse(page: URL, value: string, age: number) {
    const secure = page.protocol === "https:" ? "; Secure" : "";
    return new Response(null, { status: 204, headers: {
      ...headers, "Set-Cookie": `${cookieName}=${value}; Path=${page.pathname}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(age)}${secure}`,
    } });
  }
  function sameOrigin(request: Request, destination: URL, writes: boolean) {
    const site = request.headers.get("Sec-Fetch-Site");
    if (site && site !== "same-origin") return false;
    return !writes || (request.headers.get("Origin") === destination.origin &&
      request.headers.get("X-Lotus-Panel-Session") === "1");
  }

  const commands: CommandModule = {
    name: "@lotus-yunzai/panel-owner-session",
    commands: {},
    async fallback(message, context) {
      if (signal.aborted || !loginCommand.test(message) || context.isDelegated) return;
      const bot = context.self_id;
      const user = context.user_id;
      if (!bot || !user || !isOwner(bot, user)) return "只有当前机器人主人可以登录管理面板。";
      if (context.message_type !== "private" || context.privateCredentialSignal?.aborted !== false) {
        return "请在机器人好友私聊发送 #管理面板。";
      }
      const destination = page();
      if (!destination) return "管理面板尚未配置可用于登录的访问地址。";
      try {
        const { ticketMinutes, sessionHours } = await lifetimes();
        if (signal.aborted || context.privateCredentialSignal?.aborted !== false) return;
        if (!isOwner(bot, user)) return "只有当前机器人主人可以登录管理面板。";
        database().run("DELETE FROM credentials WHERE expiresAt <= ?", [now()]);
        const ticket = token();
        insert(ticket, "ticket", { bot, user }, ticketMinutes * 60_000);
        destination.hash = `ticket=${ticket}`;
        return `管理面板\n${destination.href}\n链接 ${ticketMinutes} 分钟内有效且只能使用一次。浏览器登录后可使用 ${sessionHours} 小时，请勿转发。`;
      } catch {
        return "暂时无法创建管理面板登录链接。";
      }
    },
  };

  return {
    commands,
    async handle(request: Request, path: string) {
      if (path !== "/panel/api/session/claim" && path !== "/panel/api/session/logout") return;
      const destination = page();
      if (!destination || signal.aborted) return response(404);
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
      if (!sameOrigin(request, destination, true)) return response(403);
      const current = browserToken(request);
      try {
        if (path.endsWith("/logout")) {
          if (current) remove(current, "session");
          return browserResponse(destination, "", 0);
        }
        const body = await readPanelJson(request, 256).catch(() => undefined);
        const key = body && typeof body === "object" && "ticket" in body ? body.ticket : undefined;
        if (typeof key !== "string" || !credential.test(key)) return response(400);
        if (!lookup(key, "ticket")) return response(401);
        const { sessionHours } = await lifetimes();
        const sessionMs = sessionHours * 3_600_000;
        if (request.signal.aborted || signal.aborted) return response(503);
        const fresh = token();
        const claimed = database().transaction(() => {
          const owner = lookup(key, "ticket");
          if (!owner) return false;
          remove(key, "ticket");
          if (!isOwner(owner.bot, owner.user)) return false;
          if (current) remove(current, "session");
          insert(fresh, "session", owner, sessionMs);
          return true;
        }).immediate();
        return claimed ? browserResponse(destination, fresh, sessionMs / 1000) : response(401);
      } catch {
        return response(503);
      }
    },
    authorize(request: Request) {
      const destination = page();
      const key = browserToken(request);
      if (!destination || !key || signal.aborted) return false;
      if (!sameOrigin(request, destination, request.method !== "GET" && request.method !== "HEAD")) return false;
      try {
        const owner = lookup(key, "session");
        if (!owner) return false;
        if (isOwner(owner.bot, owner.user)) return true;
        remove(key, "session");
      } catch {
        // Treat unavailable storage like an expired session.
      }
      return false;
    },
    close() {
      db?.close();
      db = undefined;
    },
  };
}
