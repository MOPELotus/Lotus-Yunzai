import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { CommandRegistry } from "./lib/commands.ts";
import type { MessageEvent } from "./lib/messages.ts";
import { LegacyPlugins } from "./lib/plugins/legacy.ts";
import { loadPlugins } from "./lib/plugins/loader.ts";

const commands = new CommandRegistry();
commands.registerModule({
  name: "host",
  commands: {
    "#状态": () => `Lotus-Yunzai 正在运行（Bun ${Bun.version}）`,
  },
});

if (import.meta.main) {
  const legacy = new LegacyPlugins();
  await loadPlugins(fileURLToPath(new URL("./plugins", import.meta.url)), commands, legacy);
  async function dispatch(event: MessageEvent) {
    const reply = await commands.dispatch(event.msg);
    if (reply !== undefined) {
      event.reply(reply);
      return;
    }
    await legacy.dispatch(event);
  }
  const token = Bun.env.LOTUS_ONEBOT_TOKEN;
  if (token !== undefined) {
    const portSetting = Bun.env.LOTUS_ONEBOT_PORT ?? "25360";
    const port = /^\d+$/u.test(portSetting) ? Number(portSetting) : NaN;
    const server = startOneBot(dispatch, token, port);
    console.log(`OneBot 11 正在监听 ws://127.0.0.1:${server.port}/OneBotv11`);
  }
  console.log("Lotus-Yunzai 已启动。输入 #状态 查询运行状态。");

  const consoleInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const message of consoleInput) {
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
}
