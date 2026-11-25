import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandModule } from "./commands.ts";
import { memberDisplayName } from "./adapters/onebot-member-display.ts";
import { ownerContactListSession, parseFriendList, type OwnerContactListSession } from "./owner-contact-list.ts";
import { readPanelJson } from "./panel.ts";
import { isPanelOwnerCommand } from "./panel-owner-command.ts";
import { panelPublicPage } from "./server.ts";

const cookieName = "lotus_panel";
const credential = /^[A-Za-z0-9_-]{43}$/u;
const headers = { "Cache-Control": "no-store" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const response = (status: number) => new Response(null, { status, headers });

type Kind = "ticket" | "session";
interface Owner { bot: number; user: number }
interface Credential extends Owner { expiresAt: number }
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
  const bindings = new Map<string, { gateway: OwnerContactListSession; expires: number }>();

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
    return database().query<Credential, [string, Kind, number]>(
      "SELECT bot, user, expiresAt FROM credentials WHERE hash = ? AND kind = ? AND expiresAt > ?",
    ).get(digest(key), kind, now());
  }
  function insert(key: string, kind: Kind, owner: Owner, lifetime: number) {
    database().run("INSERT INTO credentials VALUES (?, ?, ?, ?, ?)",
      [digest(key), kind, owner.bot, owner.user, Math.min(Number.MAX_SAFE_INTEGER, now() + lifetime)]);
  }
  function remove(key: string, kind: Kind) {
    const hash = digest(key);
    database().run("DELETE FROM credentials WHERE hash = ? AND kind = ?", [hash, kind]);
    bindings.delete(hash);
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

  function currentOwner(key: string, kind: Kind) {
    const owner = lookup(key, kind);
    if (!owner) return;
    if (isOwner(owner.bot, owner.user)) return owner;
    remove(key, kind);
  }

  function contactSession(request: Request, key = browserToken(request)): OwnerContactListSession | undefined {
    if (!key || request.headers.has("Authorization")) return;
    const destination = page();
    if (!destination || !sameOrigin(request, destination, request.method !== "GET" && request.method !== "HEAD")) return;
    const hash = digest(key);
    const binding = bindings.get(hash);
    const gateway = binding?.gateway;
    if (!binding || !gateway) return;
    const authorized = () => {
      if (signal.aborted || request.signal.aborted || gateway.signal.aborted || binding.expires <= now() ||
          bindings.get(hash) !== binding) return false;
      try {
        const owner = currentOwner(key, "session");
        return owner?.bot === gateway.botId && owner.user === gateway.ownerId && gateway.authorized();
      } catch {
        return false;
      }
    };
    if (authorized()) return { ...gateway, authorized };
  }

  async function contacts(request: Request, key: string | undefined) {
    const gateway = contactSession(request, key);
    if (!gateway) return response(403);
    const input = await readPanelJson(request, 1024).catch(() => undefined);
    if (!input || typeof input !== "object" || !("kind" in input) || !("query" in input) || !("page" in input) ||
        (input.kind !== "group" && input.kind !== "friend") || typeof input.query !== "string" ||
        input.query.length > 80 || typeof input.page !== "number" || !Number.isSafeInteger(input.page) ||
        input.page < 1 || input.page > 250) return response(400);
    if (!gateway.authorized()) return response(403);
    const active = AbortSignal.any([signal, request.signal, gateway.signal, AbortSignal.timeout(10_000)]);
    const list = input.kind === "group" ? await gateway.groups(active).catch(() => undefined) :
      parseFriendList(await gateway.friends(active).catch(() => undefined));
    if (!gateway.authorized()) return response(403);
    if (!list || active.aborted) return response(503);
    const query = input.query.trim().toLowerCase();
    const matched = list.filter(({ id, name }) => String(id).includes(query) || name?.toLowerCase().includes(query));
    const start = (input.page - 1) * 30;
    const items = matched.slice(start, start + 30).map(({ id, name }) =>
      ({ id, name: memberDisplayName(name)?.replace(/[\u202a-\u202e\u2066-\u2069]/gu, "") }));
    return Response.json({ items, next: input.page < 250 && start + 30 < matched.length }, { headers });
  }

  const commands: CommandModule = {
    name: "@lotus-yunzai/panel-owner-session",
    commands: {},
    async fallback(message, context) {
      if (signal.aborted || !isPanelOwnerCommand(context.normalizedMessage) || context.isDelegated) return;
      const bot = context.self_id;
      const user = context.user_id;
      if (!bot || !user || !isOwner(bot, user)) return $t("lib.panel-owner-session.text_b27ca4f6aa");
      if (context.message_type !== "private" || context.privateCredentialSignal?.aborted !== false) {
        return $t("lib.panel-owner-session.text_003b632472");
      }
      const destination = page();
      if (!destination) return $t("lib.panel-owner-session.text_a3ecd7e8cc");
      try {
        const { ticketMinutes, sessionHours } = await lifetimes();
        if (signal.aborted || context.privateCredentialSignal?.aborted !== false) return;
        if (!isOwner(bot, user)) return $t("lib.panel-owner-session.text_b27ca4f6aa");
        database().run("DELETE FROM credentials WHERE expiresAt <= ?", [now()]);
        for (const [hash, binding] of bindings) {
          if (binding.expires <= now() || binding.gateway.signal.aborted) bindings.delete(hash);
        }
        const ticket = token();
        insert(ticket, "ticket", { bot, user }, ticketMinutes * 60_000);
        const gateway = context[ownerContactListSession];
        if (gateway?.botId === bot && gateway.ownerId === user && !gateway.signal.aborted && gateway.authorized()) {
          bindings.set(digest(ticket), { gateway, expires: now() + ticketMinutes * 60_000 });
        }
        destination.hash = `ticket=${ticket}`;
        return $t("lib.panel-owner-session.text_aec013a08e", { "href": destination.href, "ticketMinutes": ticketMinutes, "sessionHours": sessionHours });
      } catch {
        return $t("lib.panel-owner-session.text_ff1f4eb349");
      }
    },
  };

  return {
    commands,
    contactSession,
    async handle(request: Request, path: string) {
      if (path === "/panel/api/session/current") {
        const destination = page();
        if (!destination || signal.aborted) return response(404);
        if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
        if (!sameOrigin(request, destination, false) || request.headers.get("X-Lotus-Panel-Session") !== "1") return response(403);
        const current = browserToken(request);
        if (!current || request.headers.has("Authorization")) return response(401);
        try {
          const session = currentOwner(current, "session");
          const serverTime = now();
          if (!session || session.expiresAt <= serverTime) return response(401);
          return Response.json({ expiresAt: session.expiresAt, now: serverTime }, { headers });
        } catch {
          return response(503);
        }
      }
      if (path !== "/panel/api/session/claim" && path !== "/panel/api/session/logout" && path !== "/panel/api/session/contacts") return;
      const destination = page();
      if (!destination || signal.aborted) return response(404);
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
      if (!sameOrigin(request, destination, true)) return response(403);
      const current = browserToken(request);
      try {
        if (path.endsWith("/contacts")) return await contacts(request, current);
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
          const owner = currentOwner(key, "ticket");
          if (!owner) return false;
          database().run("DELETE FROM credentials WHERE hash = ? AND kind = 'ticket'", [digest(key)]);
          if (current) remove(current, "session");
          insert(fresh, "session", owner, sessionMs);
          return true;
        }).immediate();
        const bound = bindings.get(digest(key));
        bindings.delete(digest(key));
        if (claimed && bound && !bound.gateway.signal.aborted) {
          bindings.set(digest(fresh), { gateway: bound.gateway, expires: now() + sessionMs });
        }
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
        return currentOwner(key, "session") !== undefined;
      } catch {
        // Treat unavailable storage like an expired session.
      }
      return false;
    },
    close() {
      bindings.clear();
      db?.close();
      db = undefined;
    },
  };
}
