import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { CommandRegistry } from "./lib/commands.ts";
import type { MessageEvent } from "./lib/messages.ts";
import { LegacyPlugins } from "./lib/plugins/legacy.ts";
import { loadPlugins, systemModuleName } from "./lib/plugins/loader.ts";

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
  let server: ReturnType<typeof startOneBot> | undefined;

  function stop(code: number) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    void legacy.stopTasks();
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
    const reply = await commands.dispatch(event.msg);
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
    const valkeyUrl = Bun.env.LOTUS_VALKEY_URL;
    if (valkeyUrl !== undefined) {
      globalThis.redis = await connectStorage(valkeyUrl);
      console.log("[存储] Valkey 已连接。");
    }
    await loadPlugins(fileURLToPath(new URL("./plugins", import.meta.url)), commands, legacy);
    if (!stopping) {
      if (!commands.hasModule(systemModuleName)) {
        throw new Error("系统模块未加载，请先运行 bun scripts/bootstrap.ts。");
      }
      const token = Bun.env.LOTUS_ONEBOT_TOKEN;
      if (token !== undefined) {
        const portSetting = Bun.env.LOTUS_ONEBOT_PORT ?? "25360";
        const port = /^\d+$/u.test(portSetting) ? Number(portSetting) : NaN;
        server = startOneBot(dispatch, token, port);
        console.log(`OneBot 11 正在监听 ws://127.0.0.1:${server.port}/OneBotv11`);
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
            isMaster: false,
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
      if (server) await shutdown.promise;
    }
  } finally {
    stopping = true;
    try {
      consoleInput?.close();
      await server?.stop(true);
      await Promise.allSettled(pending);
    } finally {
      try {
        await legacy.dispose();
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
        globalThis.redis = undefined;
        await closeStorage();
      }
    }
  }
}
