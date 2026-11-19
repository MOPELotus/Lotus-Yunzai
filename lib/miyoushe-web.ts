import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_PROFILE_ID, ProfileError, profileGames, type Game } from "@lotus-yunzai/account";
import { bbsCheckinForums } from "@lotus-yunzai/hoyo-client";
import { MiyousheExchangeError } from "@lotus-yunzai/hoyo-client/miyoushe-exchange";
import type { CommandModule } from "./commands.ts";
import type { MiyousheOverview, MiyousheOverviewTarget } from "./miyoushe-overview.ts";
import { MiyousheShopError, type createMiyousheShopCatalog } from "./miyoushe-shop-catalog.ts";
import { MiyousheShopPlanError, type createMiyousheShopPlans } from "./miyoushe-shop-plans.ts";
import { readPanelJson } from "./panel.ts";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const command = /^#(米游社功能|米游币兑换|米游币商城)([1-9]\d{0,2})?$/u;
const sessionName = "lotus_miyoushe";

export function isMiyousheWebCommand(message: string) { return command.test(message); }
const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://bbs-static.miyoushe.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex, nofollow, noarchive",
};

interface Row extends MiyousheOverviewTarget {
  readonly account: string;
  readonly expiresAt: number;
}

type VerifyLogin = () => Promise<void>;
export interface MiyoushePreviewSettingsPatch {
  readonly enabled: boolean;
  readonly games: readonly Game[];
  readonly revision: string;
}
export interface MiyoushePreviewSettings extends MiyoushePreviewSettingsPatch {
  readonly canEnable?: boolean;
  readonly waitingForHistory?: boolean;
}
export class MiyousheSettingsError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503, message: string) { super(message); }
}
export class MiyoushePreviewSettingsError extends MiyousheSettingsError {}

export const miyousheCheckinGames = ["genshin", "honkai_sr", "zzz", "honkai3rd", "honkai2", "tears_of_themis"] as const;
const cloudCheckinGames = ["genshin", "zzz"] as const;
export type MiyousheCheckinGame = typeof miyousheCheckinGames[number];
export interface MiyousheCheckinSettingsPatch {
  readonly revision: string;
  readonly enabled: boolean;
  readonly notify: boolean;
  readonly community: boolean;
  readonly games: Readonly<Record<MiyousheCheckinGame, boolean>>;
  readonly forums: readonly number[];
  readonly cloud: Readonly<Record<typeof cloudCheckinGames[number], boolean>>;
}
export interface MiyousheCheckinSettings extends MiyousheCheckinSettingsPatch {
  readonly canEnable?: boolean;
  readonly cnEnabled?: boolean;
  readonly cloudBound?: MiyousheCheckinSettingsPatch["cloud"];
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function flagMap<Key extends string>(value: unknown, keys: readonly Key[]): value is Readonly<Record<Key, boolean>> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === "boolean");
}

function supportedForum(forum: unknown): forum is number {
  return typeof forum === "number" && Number.isSafeInteger(forum) && Object.hasOwn(bbsCheckinForums, forum);
}

function previewSettingsPatch(input: unknown): MiyoushePreviewSettingsPatch | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const { enabled, games, revision } = input as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || typeof enabled !== "boolean" ||
    !validRevision(revision) ||
    !Array.isArray(games) || games.length > profileGames.length || (enabled && !games.length) ||
    games.some(game => !profileGames.includes(game)) || new Set(games).size !== games.length) return;
  return { enabled, games, revision };
}

function checkinSettingsPatch(input: unknown): MiyousheCheckinSettingsPatch | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const { revision, enabled, notify, community, games, forums, cloud } = input as Record<string, unknown>;
  if (Object.keys(input).length !== 7 || !validRevision(revision) || typeof enabled !== "boolean" ||
    typeof notify !== "boolean" || typeof community !== "boolean" || !flagMap(games, miyousheCheckinGames) ||
    !flagMap(cloud, cloudCheckinGames) || !Array.isArray(forums) || forums.length > Object.keys(bbsCheckinForums).length ||
    !forums.every(supportedForum) || new Set(forums).size !== forums.length) return;
  return { revision, enabled, notify, community, games, forums, cloud };
}

interface ProfileSettings<Patch, Settings> {
  readonly read: (target: MiyousheOverviewTarget, signal: AbortSignal, verifyLogin: VerifyLogin) => Promise<Settings>;
  readonly save: (target: MiyousheOverviewTarget, patch: Patch, signal: AbortSignal, verifyLogin: VerifyLogin) => Promise<Settings>;
}

interface Options {
  readonly origin: () => URL | undefined;
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly signal: AbortSignal;
  readonly loginIdentity: (qq: string, profileId: number) => Promise<string>;
  readonly overview: (target: MiyousheOverviewTarget, signal?: AbortSignal, verifyLogin?: () => Promise<void>) => Promise<MiyousheOverview>;
  readonly catalog?: ReturnType<typeof createMiyousheShopCatalog>;
  readonly plans?: ReturnType<typeof createMiyousheShopPlans>;
  readonly shopAddresses?: (target: MiyousheOverviewTarget, signal: AbortSignal, verifyBinding: () => Promise<void>) =>
    Promise<readonly { id: string; label: string }[]>;
  readonly previewSettings?: ProfileSettings<MiyoushePreviewSettingsPatch, MiyoushePreviewSettings>;
  readonly checkinSettings?: ProfileSettings<MiyousheCheckinSettingsPatch, MiyousheCheckinSettings>;
  readonly path?: string;
  readonly ticketMinutes?: number;
  readonly sessionHours?: number;
  readonly now?: () => number;
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function generateToken() { return randomBytes(32).toString("base64url"); }
function error(status: number) { return new Response(null, { status, headers }); }

function validOrigin(base: URL | undefined) {
  if (!base || base.username || base.password || base.pathname !== "/" || base.search || base.hash) return;
  if (base.protocol === "https:" || (base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) return base;
}

function normalizedPath(value: unknown) {
  return typeof value === "string" && /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/u.test(value) &&
    !/^\/(?:Media|File|panel|captcha|OneBotv11|status)(?:\/|$)/u.test(value) ? value.replace(/\/$/u, "") : undefined;
}

export function miyousheWebSettings(raw: unknown) {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const url = typeof config.public_url === "string" && config.public_url.trim() ? URL.parse(config.public_url.trim()) : null;
  const origin = url && (url.protocol === "https:" || url.protocol === "http:") && !url.search && !url.hash && !url.username && !url.password
    ? validOrigin(new URL(url.origin)) : undefined;
  return {
    enabled: config.enable !== false,
    path: normalizedPath(config.path) ?? (origin ? normalizedPath(url?.pathname) : undefined), origin,
    ticketMinutes: typeof config.ticket_minutes === "number" ? config.ticket_minutes : undefined,
    sessionHours: typeof config.session_hours === "number" ? config.session_hours : undefined,
  };
}

export function createMiyousheWeb({ origin, databasePath, assetDirectory, signal, loginIdentity, overview, catalog, plans, shopAddresses,
  previewSettings, checkinSettings, path, ticketMinutes: configuredTicketMinutes, sessionHours: configuredSessionHours, now = Date.now }: Options) {
  const mount = normalizedPath(path) ?? "/miyoushe";
  const prefix = `${mount}/`;
  const ticketMinutes = typeof configuredTicketMinutes === "number" && Number.isSafeInteger(configuredTicketMinutes) &&
    configuredTicketMinutes >= 1 && Number.isSafeInteger(now() + configuredTicketMinutes * 60_000) ? configuredTicketMinutes : 10;
  const sessionHours = typeof configuredSessionHours === "number" && configuredSessionHours * 3600 >= 1 &&
    Number.isSafeInteger(now() + configuredSessionHours * 3_600_000) ? configuredSessionHours : 8;
  const ticketMs = ticketMinutes * 60_000;
  const sessionMs = sessionHours * 3_600_000;
  function browserCookie(session: string, age: number, secure: boolean) {
    return `${sessionName}=${session}; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(age)}${secure ? "; Secure" : ""}`;
  }
  let db: Database | undefined;
  function database() {
    if (db) return db;
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    const connection = new Database(databasePath, { create: true, strict: true });
    try {
      chmodSync(databasePath, 0o600);
      connection.exec(`PRAGMA busy_timeout = 3000;
        CREATE TABLE IF NOT EXISTS sessions (
          hash TEXT PRIMARY KEY, kind TEXT NOT NULL, qq TEXT NOT NULL,
          profileId INTEGER NOT NULL, account TEXT NOT NULL, expiresAt INTEGER NOT NULL
        ) STRICT;`);
      db = connection;
      return db;
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  function lookup(token: string, kind: "ticket" | "web", time = now()) {
    return database().query<Row, [string, string, number]>(
      "SELECT qq, profileId, account, expiresAt FROM sessions WHERE hash = ? AND kind = ? AND expiresAt > ?",
    ).get(digest(token), kind, time);
  }

  function insert(token: string, kind: "ticket" | "web", row: Row) {
    database().run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", [digest(token), kind, row.qq, row.profileId, row.account, row.expiresAt]);
  }

  function remove(token: string, kind: "ticket" | "web") {
    database().run("DELETE FROM sessions WHERE hash = ? AND kind = ?", [digest(token), kind]);
  }

  const commands: CommandModule = {
    name: "@lotus-yunzai/miyoushe", commands: {},
    async fallback(message, context) {
      const match = command.exec(message);
      if (!match || signal.aborted) return;
      if (context.message_type !== "private") return "请私聊机器人发送 #米游社功能，获取专属登录链接。";
      const connection = context.privateCredentialSignal;
      if (!connection || connection.aborted || !context.user_id) return "请从当前连接的机器人好友私聊获取登录链接。";
      const profileId = Number(match[2] ?? 1);
      if (profileId > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      const base = validOrigin(origin());
      if (!base) return "米游社功能页尚未配置可用的访问地址。";
      const qq = String(context.user_id);
      try {
        const account = await loginIdentity(qq, profileId);
        if (signal.aborted || connection.aborted) return;
        const time = now();
        database().run("DELETE FROM sessions WHERE expiresAt <= ?", [time]);
        const token = generateToken();
        insert(token, "ticket", { qq, profileId, account, expiresAt: time + ticketMs });
        const link = new URL(prefix, base);
        link.hash = `ticket=${token}${catalog && match[1] !== "米游社功能" ? "&tab=shop" : ""}`;
        return `米游社功能 · 档案 ${profileId}\n${link.href}\n链接 ${ticketMinutes} 分钟内有效，只能使用一次。浏览器登录后可使用 ${sessionHours} 小时，请勿转发。`;
      } catch (failure) {
        if (signal.aborted || connection.aborted) return;
        if (failure instanceof ProfileError) return `请先扫码登录档案 ${profileId}。`;
        return "暂时无法创建登录链接。";
      }
    },
  };

  async function handle(request: Request): Promise<Response | undefined> {
    const { pathname, search, searchParams } = new URL(request.url);
    if (pathname !== mount && !pathname.startsWith(prefix)) return;
    const base = validOrigin(origin());
    if (!base || (search && pathname !== `${prefix}api/catalog` && pathname !== `${prefix}api/tracking-targets`) || signal.aborted) return error(404);
    const method = request.method;
    const isRead = method === "GET" || method === "HEAD";
    const secure = base.protocol === "https:";
    if (pathname === mount) return isRead ? new Response(null, { status: 308, headers: { ...headers, Location: prefix } }) : error(405);
    const part = pathname.slice(prefix.length);
    const goodsId = /^api\/goods\/([1-9]\d{0,19})$/u.exec(part)?.[1];
    const planAction = /^api\/plans\/([a-f0-9]{12})\/(cancel|resolve)$/u.exec(part);
    const trackingAction = /^api\/trackers\/([a-f0-9]{12})\/(pause|resume)$/u.exec(part);
    const previewRoute = previewSettings && part === "api/preview-settings";
    const checkinRoute = checkinSettings && part === "api/checkin-settings";
    const settingsRoute = previewRoute || checkinRoute;
    const editingPlans = plans && (planAction || trackingAction ||
      ((part === "api/plans" || part === "api/trackers") && method !== "GET"));
    if (part === "" || part === "style.css" || part === "app.js") {
      if (!isRead) return error(405);
      const asset = Bun.file(join(assetDirectory, part || "index.html"));
      const contentType = part === "" ? "text/html" : part === "style.css" ? "text/css" : "text/javascript";
      return await asset.exists()
        ? new Response(method === "HEAD" ? null : asset, { headers: { ...headers, "Content-Type": `${contentType}; charset=utf-8` } })
        : error(404);
    }
    if (part === "api/claim" || part === "api/logout" || editingPlans || (settingsRoute && method !== "GET")) {
      if (method !== "POST") return error(405);
      if (request.headers.get("Origin") !== base.origin) return error(403);
    } else if (part === "api/overview" || settingsRoute || (catalog && (part === "api/catalog" || goodsId)) ||
      (plans && ["api/plans", "api/trackers", "api/tracking-targets"].includes(part))) {
      if (method !== "GET") return error(405);
      const fetchSite = request.headers.get("Sec-Fetch-Site");
      if (fetchSite && fetchSite !== "same-origin") return error(403);
    } else return error(404);

    const cookies = request.headers.get("Cookie")?.split(";").map(value => value.trim()) ?? [];
    const matches = cookies.filter(value => value.startsWith(`${sessionName}=`));
    const session = matches.length === 1 ? matches[0]?.slice(sessionName.length + 1) : undefined;
    const currentToken = session && tokenPattern.test(session) ? session : undefined;
    const deadline = AbortSignal.any([signal, request.signal, AbortSignal.timeout(24_000)]);
    try {
      if (part === "api/claim") {
        const data = await readPanelJson(request).catch(() => undefined);
        const token = data && typeof data === "object" && "ticket" in data ? data.ticket : undefined;
        if (typeof token !== "string" || !tokenPattern.test(token)) return error(400);
        const ticket = lookup(token, "ticket");
        if (!ticket || deadline.aborted) return error(401);
        if (await loginIdentity(ticket.qq, ticket.profileId).catch(() => undefined) !== ticket.account) {
          remove(token, "ticket");
          return error(401);
        }
        const fresh = generateToken();
        const swapped = database().transaction(() => {
          if (!lookup(token, "ticket")) return false;
          remove(token, "ticket");
          if (currentToken) remove(currentToken, "web");
          insert(fresh, "web", { ...ticket, expiresAt: now() + sessionMs });
          return true;
        }).immediate();
        if (!swapped) return error(401);
        return new Response(null, { status: 204, headers: { ...headers, "Set-Cookie": browserCookie(fresh, sessionMs / 1000, secure) } });
      }
      if (part === "api/logout") {
        if (currentToken) remove(currentToken, "web");
        return new Response(null, { status: 204, headers: { ...headers, "Set-Cookie": browserCookie("", 0, secure) } });
      }
      if (!currentToken) return error(401);
      const row = lookup(currentToken, "web");
      if (!row) return error(401);
      async function verifyLogin() {
        const identity = await loginIdentity(row!.qq, row!.profileId).catch(() => undefined);
        if (deadline.aborted || !lookup(currentToken!, "web")) throw new ProfileError("changed", "网页会话已失效。");
        if (identity !== row!.account) {
          remove(currentToken!, "web");
          throw new ProfileError("changed", "网页会话对应的档案已换绑。");
        }
      }
      await verifyLogin();
      const target = { qq: row.qq, profileId: row.profileId };
      async function serveSettings<Patch, Settings>(source: ProfileSettings<Patch, Settings>,
        decode: (input: unknown) => Patch | undefined, publicSettings: (data: Settings) => object) {
        let settings: Settings;
        if (method === "POST") {
          const patch = decode(await readPanelJson(request).catch(() => undefined));
          if (!patch) return Response.json({ message: "请提交有效的档案设置。" }, { status: 400, headers });
          await verifyLogin();
          settings = await source.save(target, patch, deadline, verifyLogin);
        } else settings = await source.read(target, deadline, verifyLogin);
        await verifyLogin();
        return Response.json(publicSettings(settings), { headers });
      }
      if (previewRoute && previewSettings) {
        return await serveSettings(previewSettings, previewSettingsPatch, settings => ({
          enabled: settings.enabled, games: settings.games, revision: settings.revision,
          canEnable: settings.canEnable !== false, waitingForHistory: settings.waitingForHistory === true,
        }));
      }
      if (checkinRoute && checkinSettings) {
        return await serveSettings(checkinSettings, checkinSettingsPatch, settings => ({
          enabled: settings.enabled, notify: settings.notify, community: settings.community, revision: settings.revision,
          games: Object.fromEntries(miyousheCheckinGames.map(game => [game, settings.games[game]])),
          forums: [...new Set(settings.forums.filter(supportedForum))],
          cloud: Object.fromEntries(cloudCheckinGames.map(game => [game, settings.cloud[game] === true])),
          cloudBound: Object.fromEntries(cloudCheckinGames.map(game => [game, settings.cloudBound?.[game] === true])),
          canEnable: settings.canEnable !== false, cnEnabled: settings.cnEnabled !== false,
        }));
      }
      if (plans && part === "api/tracking-targets") {
        if (searchParams.getAll("game").length !== 1 || searchParams.getAll("itemType").length !== 1 ||
          [...searchParams.keys()].some(key => key !== "game" && key !== "itemType")) return error(400);
        const result = await plans.trackerTargets(target, searchParams.get("game"), Number(searchParams.get("itemType")), deadline, verifyLogin);
        await verifyLogin();
        return Response.json(result, { headers });
      }
      if (plans && (part === "api/trackers" || trackingAction)) {
        const body = method === "POST" ? await readPanelJson(request).catch(() => undefined) : undefined;
        const confirmed = body && typeof body === "object" && "confirmed" in body ? body.confirmed : undefined;
        const result = trackingAction ? await plans.setTracker(target, trackingAction[1]!, trackingAction[2] === "resume",
          confirmed, deadline, verifyLogin) : method === "GET" ? await plans.listTrackers(target, verifyLogin)
          : await plans.createTracker(target, body, deadline, verifyLogin);
        await verifyLogin();
        return Response.json(result, { headers });
      }
      if (plans && part === "api/plans") {
        const result = method === "GET" ? await plans.list(target, verifyLogin) : await plans.reserve(target,
          await readPanelJson(request).catch(() => undefined), deadline, verifyLogin);
        await verifyLogin();
        return Response.json(result, { headers });
      }
      if (plans && planAction) {
        const [, id, action] = planAction;
        const body = action === "resolve" ? await readPanelJson(request).catch(() => undefined) : undefined;
        const redeemed = body && typeof body === "object" && "redeemed" in body ? body.redeemed : undefined;
        const result = action === "cancel" ? await plans.cancel(target, id!, verifyLogin)
          : await plans.resolve(target, id!, redeemed, verifyLogin);
        await verifyLogin();
        return Response.json(result, { headers });
      }
      if (catalog && goodsId) {
        const detail = await catalog.detail(target, goodsId, deadline, verifyLogin);
        const addresses = detail.good.type === 1 && shopAddresses
          ? await shopAddresses(target, deadline, verifyLogin).catch(() => undefined) : undefined;
        await verifyLogin();
        return Response.json({ ...detail, ...(addresses && { addresses }), expiresAt: row.expiresAt }, { headers });
      }
      const view = catalog && part === "api/catalog" ? await catalog.list(target, searchParams, deadline, verifyLogin)
        : await overview(target, deadline, verifyLogin);
      await verifyLogin();
      return Response.json({ ...view, ...(part === "api/overview" && {
        previewSettingsAvailable: Boolean(previewSettings), checkinSettingsAvailable: Boolean(checkinSettings),
      }),
        expiresAt: row.expiresAt }, { headers });
    } catch (failure) {
      if (failure instanceof ProfileError && failure.code === "changed") return error(401);
      if (failure instanceof MiyousheShopError || failure instanceof MiyousheShopPlanError || failure instanceof MiyousheExchangeError ||
          failure instanceof MiyousheSettingsError) {
        return Response.json({ message: failure.message }, { status: failure.status, headers });
      }
      return error(503);
    }
  }

  return { commands, handle, close() { db?.close(); db = undefined; } };
}
