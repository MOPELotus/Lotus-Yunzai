import { createInterface } from "node:readline";
import { CommandRegistry } from "./lib/commands.ts";

const commands = new CommandRegistry();
commands.register("#状态", () => `Lotus-Yunzai 正在运行（Bun ${Bun.version}）`);

if (import.meta.main) {
  console.log("Lotus-Yunzai 已启动。输入 #状态 查询运行状态。");

  const consoleInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const message of consoleInput) {
    const reply = await commands.dispatch(message);
    if (reply !== undefined) {
      console.log(reply);
    }
  }
}
