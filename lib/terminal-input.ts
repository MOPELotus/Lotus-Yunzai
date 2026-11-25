import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { setInteractiveTerminalInputActive } from "./terminal-output.ts";
import { createInterface, clearLine, clearScreenDown, cursorTo, moveCursor } from "node:readline";

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
  let visible = false, drawing = false, editing = false;
  const nativePrompt = readline.prompt.bind(readline);
  readline.setPrompt(process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0" ? "> " : "\x1b[36m>\x1b[0m ");
  readline.prompt = (preserveCursor?: boolean) => {
    visible = true;
    drawing = true;
    try { nativePrompt(preserveCursor); } finally { drawing = false; }
  };
  const keyboard = () => { editing = true; queueMicrotask(() => { editing = false; }); };
  process.stdin.prependListener("data", keyboard);
  readline.on("line", () => { visible = false; });
  const restore: (() => void)[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    const proxy = ((chunk: unknown, ...args: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (drawing || editing || !visible || !text.includes("\n")) return Reflect.apply(original, stream, [chunk, ...args]) as boolean;
      drawing = true;
      try {
        clearLine(output, 0);
        cursorTo(output, 0);
        const result = Reflect.apply(original, stream, [chunk, ...args]) as boolean;
        if (!text.endsWith("\n")) Reflect.apply(original, stream, ["\n"]);
        nativePrompt(true);
        return result;
      } finally { drawing = false; }
    }) as typeof stream.write;
    stream.write = proxy;
    restore.push(() => { if (stream.write === proxy) stream.write = original; });
  }
  setInteractiveTerminalInputActive(true, write => {
    if (drawing || editing || !visible) return write();
    drawing = true;
    try {
      clearLine(output, 0);
      cursorTo(output, 0);
      const result = write();
      nativePrompt(true);
      return result;
    } finally { drawing = false; }
  });
  readline.once("close", () => {
    if (visible) {
      drawing = true;
      try {
        const { rows } = readline.getCursorPos();
        if (rows) moveCursor(output, 0, -rows);
        cursorTo(output, 0);
        clearScreenDown(output);
      } finally { drawing = false; }
    }
    visible = false;
    setInteractiveTerminalInputActive(false);
    process.stdin.removeListener("data", keyboard);
    for (const reset of restore) reset();
  });
  readline.on("SIGINT", interrupt);
  // Plugins may accept credentials or other private input. Keep only complete,
  // argument-free, known commands in the current session history.
  readline.on("history", (history: string[]) => {
    if (history.length && !historyCommands.has(history[0]!.trim())) history.shift();
  });
  readline.prompt();
  return readline;
}
