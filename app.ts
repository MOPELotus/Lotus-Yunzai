import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { accountCommands } from "./lib/account-commands.ts";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { OneBotGroups } from "./lib/adapters/onebot-groups.ts";
import { CommandRegistry } from "./lib/commands.ts";
import { readFriendRequests } from "./lib/friend-requests.ts";
import type { BotEvent, MessageEvent } from "./lib/messages.ts";
import { panelApi, panelAssets } from "./lib/panel.ts";
import { panelExtensionRoutes } from "./lib/panel-extension-routes.ts";
import { panelGroupSettings } from "./lib/panel-group.ts";
import { panelGuobaRoutes } from "./lib/panel-guoba-routes.ts";
import { LegacyPlugins } from "./lib/plugins/legacy.ts";
import { loadPlugins, systemModuleName, type PluginLoadReport } from "./lib/plugins/loader.ts";
import { stopStaticRenderer } from "./lib/renderer/shotium.ts";
import { readAccountRefreshPermission, readMasterPermissions } from "./lib/permissions.ts";
import { readPrivateAccess } from "./lib/private-access.ts";
import { httpStatus, readServerSettings } from "./lib/server.ts";

declare global {
  var redis: Awaited<ReturnType<typeof connectStorage>> | undefined;
}

const commands = new CommandRegistry();

if (import.meta.main) {
  const legacy = new LegacyPlugins();
  const groups = new OneBotGroups();
  const pending = new Set<Promise<void>>();
  const shutdown = Promise.withResolvers<void>();
  const lifecycle = new AbortController();
  let plugins: PluginLoadReport | undefined;
  let stopping = false;
  let consoleInput: ReturnType<typeof createInterface> | undefined;
  const servers: Pick<ReturnType<typeof startOneBot>, "stop">[] = [];
  const root = new URL("./", import.meta.url);
  let privateAccess: Awaited<ReturnType<typeof readPrivateAccess>>;
  let autoFriend: Awaited<ReturnType<typeof readFriendRequests>>;

  function stop(code: number) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    lifecycle.abort();
    void legacy.stopTasks();
    legacy.stopContexts();
    consoleInput?.close();
    shutdown.resolve();
  }

  async function dispatch(event: BotEvent) {
    if (stopping) return;
    const handling = handleEvent(event);
    pending.add(handling);
    try {
      await handling;
    } finally {
      pending.delete(handling);
    }
  }

  async function handleEvent(event: BotEvent) {
    if (event.post_type === "message") return dispatchMessage(event);
    if (event.post_type === "notice" && event.notice_type === "friend" && await privateAccess.blockedPoke(event)) return;
    if (event.post_type === "request" && event.request_type === "friend") {
      let reviewed = false;
      const consumed = await legacy.dispatch({
        ...event,
        approve(approve?: boolean, remark?: string) {
          reviewed = true;
          return event.approve(approve, remark);
        },
      });
      if (!reviewed && !consumed) await autoFriend(event, lifecycle.signal);
      return;
    }
    await legacy.dispatch(event);
  }

  async function dispatchMessage(event: MessageEvent) {
    if (await privateAccess.blocked(event)) return;
    if (await legacy.dispatchContext(event)) return;

    const reply = await commands.dispatch(event.msg, event);
    if (reply !== undefined) {
      event.reply(reply);
      return;
    }
    await legacy.dispatch(event);
  }

  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const [network, permissions, canRefresh, access, friendRequests] = await Promise.all([
      readServerSettings(root, Bun.env), readMasterPermissions(root), readAccountRefreshPermission(root),
      readPrivateAccess(root, async (userId) =>
        !globalThis.redis || await globalThis.redis.set(`Yz:disablePrivate:${userId}`, "1", { EX: 10, NX: true }) === "OK"),
      readFriendRequests(root),
    ]);
    privateAccess = access;
    autoFriend = friendRequests;
    const valkeyUrl = Bun.env.LOTUS_VALKEY_URL;
    if (valkeyUrl !== undefined) {
      globalThis.redis = await connectStorage(valkeyUrl);
      console.log("[存储] Valkey 已连接。");
    }
    commands.registerModule(accountCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, canRefresh));
    plugins = await loadPlugins(fileURLToPath(new URL("plugins", root)), commands, legacy, Object.freeze({
      groups: groups.transport(), signal: lifecycle.signal,
    }));
    if (!stopping) {
      if (!commands.hasModule(systemModuleName)) {
        throw new Error("系统模块未加载，请先运行 bun scripts/bootstrap.ts。");
      }
      const { hostname, http, oneBot, panelToken } = network;
      const statusRoute = http && httpStatus(http.auth);
      const likes = panelGroupSettings(plugins.directories);
      const guoba = panelGuobaRoutes(plugins.directories);
      const extensions = panelToken === undefined ? undefined : panelExtensionRoutes(plugins.directories);
      const panel = panelToken === undefined ? undefined : panelApi(panelToken, plugins.records,
        (path) => path === "/panel/api/settings/group/likes" ? likes : guoba(path) ?? extensions?.api(path));
      const assets = panel && panelAssets(fileURLToPath(new URL("panel/dist", root)));
      const fetch = statusRoute && (async (request: Request) => stopping
        ? new Response(null, { status: 503 })
        : await panel?.(request) ?? await extensions?.assets(request) ?? await assets?.(request) ?? statusRoute(request));
      const shared = http !== undefined && oneBot !== undefined && http.port === oneBot.port;
      if (oneBot) {
        const server = startOneBot(dispatch, {
          hostname, ...oneBot, groups, isMaster: permissions.isMaster, masterIds: permissions.masterIds,
          http: shared ? fetch : undefined,
        });
        servers.push(server);
        console.log(`OneBot 11 正在监听 ${server.url.origin.replace(/^http/u, "ws")}/OneBotv11`);
        if (shared) console.log(`HTTP 正在监听 ${server.url.origin}/status`);
      }
      if (http && !shared && fetch) {
        const server = Bun.serve({ hostname, port: http.port, fetch });
        servers.push(server);
        console.log(`HTTP 正在监听 ${server.url.origin}/status`);
      }
      console.log("Lotus-Yunzai 已启动。输入 #状态 查询运行状态。");

      consoleInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const message of consoleInput) {
        if (stopping) break;
        const waiting = Promise.withResolvers<void>();
        const handling = dispatch({
          msg: message.trim(),
          raw_message: message,
          message,
          post_type: "message",
          message_type: "terminal",
          isGroup: false,
          isPrivate: false,
          isMaster: permissions.terminal,
          onAwaitInput: waiting.resolve,
          reply(text) {
            if (typeof text !== "string") return false;

            console.log(text);
            return true;
          },
        }).catch(() => {
          console.error("处理终端指令失败。");
        });
        await Promise.race([handling, waiting.promise]);
      }
      if (servers.length) await shutdown.promise;
    }
  } finally {
    stopping = true;
    lifecycle.abort();
    try {
      consoleInput?.close();
      legacy.stopContexts();
      await Promise.allSettled(pending);
      await plugins?.dispose();
    } finally {
      try {
        await Promise.all(servers.map((server) => server.stop(true)));
      } finally {
        try {
          await legacy.dispose();
        } finally {
          process.off("SIGINT", interrupt);
          process.off("SIGTERM", terminate);
          globalThis.redis = undefined;
          await Promise.all([closeStorage(), stopStaticRenderer()]);
        }
      }
    }
  }
}
