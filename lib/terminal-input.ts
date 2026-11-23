import { createInterface } from "node:readline";

const historyCommands = new Set([
  "#状态", "#状态Pro", "#状态pro", "#版本",
  "#帮助", "#help", "#星铁帮助", "#星铁help", "*帮助", "*help",
  "#绝区零帮助", "#绝区零help", "%帮助", "%help", "#自动签到帮助",
]);

export function createTerminalInput(interrupt: () => void) {
  const output = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : undefined;
  if (!process.stdin.isTTY || output === undefined) {
    return createInterface({ input: process.stdin, crlfDelay: Infinity });
  }
  const readline = createInterface({
    input: process.stdin, output, terminal: true, historySize: 30, removeHistoryDuplicates: true, crlfDelay: Infinity,
  });
  readline.on("SIGINT", interrupt);
  // Plugins may accept credentials or other private input. Keep only complete,
  // argument-free, known commands in the current session history.
  readline.on("history", (history: string[]) => {
    if (history.length && !historyCommands.has(history[0]!.trim())) history.shift();
  });
  return readline;
}
