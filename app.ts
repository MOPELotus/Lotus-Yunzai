import { createInterface } from "node:readline";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { CommandRegistry } from "./lib/commands.ts";

const commands = new CommandRegistry();
commands.registerModule({
  name: "host",
  commands: {
    "#状态": () => `Lotus-Yunzai 正在运行（Bun ${Bun.version}）`,
  },
});

if (import.meta.main) {
  const token = Bun.env.LOTUS_ONEBOT_TOKEN;
  if (token !== undefined) {
    const portSetting = Bun.env.LOTUS_ONEBOT_PORT ?? "25360";
    const port = /^\d+$/u.test(portSetting) ? Number(portSetting) : NaN;
    const server = startOneBot(commands, token, port);
    console.log(`OneBot 11 正在监听 ws://127.0.0.1:${server.port}/OneBotv11`);
  }
  console.log("Lotus-Yunzai 已启动。输入 #状态 查询运行状态。");

  const consoleInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const message of consoleInput) {
    const reply = await commands.dispatch(message);
    if (reply !== undefined) {
      console.log(reply);
    }
  }
}
