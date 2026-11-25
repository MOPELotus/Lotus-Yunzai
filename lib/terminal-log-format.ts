import { withTerminalOutput } from "./terminal-output.ts";
import { formatWithOptions } from "node:util";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "mark";
const colors: Record<LogLevel, number> = { trace: 34, debug: 36, info: 32, warn: 33, error: 31, fatal: 35, mark: 90 };
const levels: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "mark"];
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
export function terminalColorsEnabled(level: LogLevel = "info") {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return (level === "warn" || level === "error" || level === "fatal" ? process.stderr.isTTY : process.stdout.isTTY) === true;
}
export function formattedLogLevel(message: string, fallback: LogLevel): LogLevel {
  const match = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[([A-Z]+)\]/u.exec(sanitizeRuntimeLog(message, 32000));
  return match ? levels.find(item => item.toUpperCase().startsWith(match[1]!)) ?? fallback : fallback;
}
export function formatTerminalLog(level: LogLevel, message: string, options: {
  readonly now?: Date; readonly color?: boolean; readonly fullLevel?: boolean; readonly label?: string | false;
} = {}) {
  let content = sanitizeRuntimeLog(message, 32_000);
  const now = options.now ?? new Date();
  let time = `${clock.format(now)}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  // A worker or the runtime file writer may already have formatted this line.
  const previous = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\[(TRACE|TRAC|DEBUG|DEBU|INFO|WARN|ERROR|ERRO|FATAL|FATA|MARK)\]\s?(.*)$/u.exec(content);
  if (previous) {
    time = previous[1]!;
    level = levels.find(item => item.toUpperCase().startsWith(previous[2]!)) ?? level;
    content = previous[3]!;
  }
  if (!previous && options.label !== false && !/^\[[^\]\r\n]{1,128}\]/u.test(content)) {
    const label = options.label === undefined ? "Lotus-Yunzai" : sanitizeRuntimeLog(options.label, 64);
    if (label) content = `[${label}] ${content}`;
  }
  const name = level.toUpperCase();
  const prefix = `[${time}][${options.fullLevel ? name : name.slice(0, 4)}]`;
  if (!(options.color ?? terminalColorsEnabled(level))) return `${prefix} ${content}`;
  const tag = /^(\[[^\]\r\n]{1,128}\])/u.exec(content);
  const styled = tag ? `\x1b[34m${tag[1]}\x1b[0m${content.slice(tag[1]!.length)}` : content;
  return `\x1b[${colors[level]}m${prefix}\x1b[0m ${styled}`;
}
let installed: { update(config: Readonly<Record<string, unknown>>): void; close(): void } | undefined;
/** Uses only built-in dependencies, so bootstrap can format logs before installation. */
export function installTerminalLogging(config: Readonly<Record<string, unknown>> = {}) {
  if (installed) { installed.update(config); return installed; }
  let current = config;
  const saved = { debug: console.debug, log: console.log, info: console.info, warn: console.warn, error: console.error };
  const proxies: Partial<typeof saved> = {};
  for (const [method, level] of Object.entries({ debug: "debug", log: "info", info: "info", warn: "warn", error: "error" }) as [keyof typeof saved, LogLevel][]) {
    const proxy = (...args: unknown[]) => {
      const threshold = current.log_level === "off" ? Infinity : levels.indexOf(typeof current.log_level === "string" ? current.log_level.toLowerCase() as LogLevel : "info");
      const message = formatWithOptions({ colors: false, customInspect: false, getters: false }, ...args);
      const encoded = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[([A-Z]+)\]/u.exec(sanitizeRuntimeLog(message, 32000));
      const severity = encoded ? levels.find(item => item.toUpperCase().startsWith(encoded[1]!)) ?? level : level;
      if (levels.indexOf(severity) < Math.max(0, threshold) && levels.indexOf(severity) < 3) return;
      withTerminalOutput(() => saved[method].call(console, formatTerminalLog(severity, message, { label: typeof current.log_align === "string" ? current.log_align : undefined })));
    };
    proxies[method] = proxy;
    console[method] = proxy;
  }
  installed = {
    update(next) { current = next; },
    close() {
      for (const method of Object.keys(saved) as (keyof typeof saved)[]) if (console[method] === proxies[method]) console[method] = saved[method];
      installed = undefined;
    },
  };
  return installed;
}
