import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { accountCommands } from "./lib/account-commands.ts";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { CommandRegistry } from "./lib/commands.ts";
import type { MessageEvent } from "./lib/messages.ts";
import { LegacyPlugins } from "./lib/plugins/legacy.ts";
import { loadPlugins, systemModuleName } from "./lib/plugins/loader.ts";
import { stopStaticRenderer } from "./lib/renderer/shotium.ts";
import { readAccountRefreshPermission, readMasterPermissions } from "./lib/permissions.ts";
import { httpStatus, readServerSettings } from "./lib/server.ts";

declare global {
  var redis: Awaited<ReturnType<typeof connectStorage>> | undefined;
}

const commands = new CommandRegistry();

if (import.meta.main) {
  const legacy = new LegacyPlugins();
  const pending = new Set<Promise<void>>();
  const shutdown = Promise.withResolvers<void>();
  let stopping = false;
  let consoleInput: ReturnType<typeof createInterface> | undefined;
  const servers: Pick<ReturnType<typeof startOneBot>, "stop">[] = [];
  const root = new URL("./", import.meta.url);

  function stop(code: number) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    void legacy.stopTasks();
    legacy.stopContexts();
    consoleInput?.close();
    shutdown.resolve();
  }

  async function dispatch(event: MessageEvent) {
    if (stopping) return;
    const handling = dispatchMessage(event);
    pending.add(handling);
    try {
      await handling;
    } finally {
      pending.delete(handling);
    }
  }

  async function dispatchMessage(event: MessageEvent) {
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
    const [network, permissions, canRefresh] = await Promise.all([
      readServerSettings(root, Bun.env), readMasterPermissions(root), readAccountRefreshPermission(root),
    ]);
    const valkeyUrl = Bun.env.LOTUS_VALKEY_URL;
    if (valkeyUrl !== undefined) {
      globalThis.redis = await connectStorage(valkeyUrl);
      console.log("[存储] Valkey 已连接。");
    }
    commands.registerModule(accountCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, canRefresh));
    await loadPlugins(fileURLToPath(new URL("plugins", root)), commands, legacy);
    if (!stopping) {
      if (!commands.hasModule(systemModuleName)) {
        throw new Error("系统模块未加载，请先运行 bun scripts/bootstrap.ts。");
      }
      const { hostname, http, oneBot } = network;
      const statusRoute = http && httpStatus(http.auth);
      const shared = http !== undefined && oneBot !== undefined && http.port === oneBot.port;
      if (oneBot) {
        const server = startOneBot(dispatch, {
          hostname, ...oneBot, isMaster: permissions.isMaster, http: shared ? statusRoute : undefined,
        });
        servers.push(server);
        console.log(`OneBot 11 正在监听 ${server.url.origin.replace(/^http/u, "ws")}/OneBotv11`);
        if (shared) console.log(`HTTP 正在监听 ${server.url.origin}/status`);
      }
      if (http && !shared && statusRoute) {
        const server = Bun.serve({ hostname, port: http.port, fetch: statusRoute });
        servers.push(server);
        console.log(`HTTP 正在监听 ${server.url.origin}/status`);
      }
      console.log("Lotus-Yunzai 已启动。输入 #状态 查询运行状态。");

      consoleInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const message of consoleInput) {
        if (stopping) break;
        try {
          await dispatch({
            msg: message.trim(),
            raw_message: message,
            message,
            post_type: "message",
            message_type: "terminal",
            isGroup: false,
            isPrivate: false,
            isMaster: permissions.terminal,
            reply(text) {
              if (typeof text !== "string") return false;

              console.log(text);
              return true;
            },
          });
        } catch {
          console.error("处理终端指令失败。");
        }
      }
      if (servers.length) await shutdown.promise;
    }
  } finally {
    stopping = true;
    try {
      consoleInput?.close();
      await Promise.all(servers.map((server) => server.stop(true)));
      await Promise.allSettled(pending);
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
