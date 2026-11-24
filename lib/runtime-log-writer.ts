import { withTerminalOutput } from "./terminal-output.ts";
import { formatTerminalLog, formattedLogLevel } from "./terminal-log-format.ts";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatWithOptions, inspect, types } from "node:util";
import { logObjectOptions } from "./log-object-options.ts";
import { archiveRuntimeLogs } from "./runtime-log-archive.ts";
import { runtimeLogDirectory, runtimeLogFilename, sanitizeRuntimeLog } from "./runtime-logs.ts";

const priorities = ["trace", "debug", "info", "warn", "error", "fatal", "mark", "off"];
const consoleLevels = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;
const pendingLimit = 512;
const defaultLabel = "LOTUS-YUNZAI";

function minimumLevel(config: Readonly<Record<string, unknown>>) {
  const level = typeof config.log_level === "string" ? priorities.indexOf(config.log_level.toLowerCase()) : -1;
  return level < 0 ? priorities.indexOf("info") : level;
}

function configuredLogLength(value: unknown) {
  const limit = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 32_000) : undefined;
}

const compatibilityLevels = {
  trace: "debug", debug: "debug", info: "info", warn: "warn", mark: "info", error: "error", fatal: "error",
} as const;
type PluginLogLevel = keyof typeof compatibilityLevels;

export function runtimePluginLogger(config: Readonly<Record<string, unknown>>,
  write?: (level: PluginLogLevel, message: string) => void) {
  const log = createPluginLog(config, write);
  const levels = Object.keys(compatibilityLevels) as PluginLogLevel[];
  return Object.freeze(Object.fromEntries(levels.map(level => [level, (...args: unknown[]) => log(level, args, false)])));
}

export function createPluginLog(config: Readonly<Record<string, unknown>>,
  write: (level: PluginLogLevel, message: string) => void = (level, message) => console[compatibilityLevels[level]](message)) {
  const limit = configuredLogLength(config.log_length) ?? 10_000;
  const setting = config.log_object;
  const { length: partLimit = limit, ...objectOptions } = logObjectOptions(setting) ?? {};
  const options = { depth: 10, maxArrayLength: 100, maxStringLength: 1_000, ...objectOptions,
    colors: false, customInspect: false, getters: false, showHidden: false, showProxy: false } as const;
  const label = typeof config.log_align === "string" ? sanitizeRuntimeLog(config.log_align, 64) : defaultLabel;
  const projectLabel = /^(?:TRSSYz|TRSS-Yunzai|Lotus-Yunzai)$/iu.test(label.trim()) ? label.replace(label.trim(), defaultLabel) : label;

  function identifier(id: unknown, force: unknown) {
    if (id === false) return "";
    const value = typeof id === "string" ? sanitizeRuntimeLog(id, 256)
      : (typeof id === "number" && Number.isFinite(id)) || typeof id === "bigint" ? String(id) : "";
    if (!value) return `[${projectLabel || defaultLabel}]`;
    if (force === true || !label) return `[${value}]`;
    const gaps = label.length - value.length;
    if (gaps < 0) return `[${value.slice(0, label.length - 1).toWellFormed()}.]`;
    return `[${" ".repeat(Math.ceil(gaps / 2))}${value}${" ".repeat(Math.floor(gaps / 2))}]`;
  }

  function format(value: unknown) {
    if (typeof value === "string") return value;
    if (types.isProxy(value)) return "[代理对象]";
    if (setting !== false) return inspect(value, options);
    if (types.isNativeError(value)) {
      const message: unknown = Object.getOwnPropertyDescriptor(value, "message")?.value;
      return typeof message === "string" && message ? `Error: ${message}` : "Error";
    }
    if (value && typeof value === "object") return Array.isArray(value) ? "[object Array]" : "[object Object]";
    if (typeof value === "function") return "[Function]";
    return String(value);
  }

  return (level: unknown, message: unknown, id?: unknown, force?: unknown): void => {
    if (typeof level !== "string" || !Object.hasOwn(compatibilityLevels, level)) return;
    const severity = priorities.indexOf(level);
    if (severity >= 0 && severity < priorities.indexOf("warn") && severity < minimumLevel(config)) return;
    const args = !types.isProxy(message) && Array.isArray(message) ? message : [message];
    const tag = identifier(id, force);
    const parts = [tag];
    for (let index = 0; index < Math.min(args.length, 100); index++) {
      const value: unknown = Object.getOwnPropertyDescriptor(args, index)?.value;
      parts.push(sanitizeRuntimeLog(format(value), partLimit));
    }
    const line = sanitizeRuntimeLog(parts.filter(Boolean).join(" "), limit);
    if (line) write(level as PluginLogLevel, line);
  };
}

async function append(file: string, line: string): Promise<void> {
  const handle = await open(file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("日志目标须为普通文件。");
    await handle.writeFile(line, "utf8");
  } finally {
    await handle.close();
  }
}

export async function attachRuntimeLog(root: URL, config: Readonly<Record<string, unknown>>) {
  const host = await realpath(fileURLToPath(root));
  const configured = join(host, "logs");
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const directory = await runtimeLogDirectory(host);

  const maxLength = configuredLogLength(config.log_length) ?? 10_000;
  const warn = console.warn.bind(console);
  const restorations: (() => void)[] = [];
  let queued = 0;
  let tail = Promise.resolve();
  let archiveWork = Promise.resolve();
  const archiveLifecycle = new AbortController();
  let lastLogDate = "";
  let warned = false;
  let archiveWarned = false;
  let closed = false;

  function enqueue(level: PluginLogLevel, message: string, project = true) {
    if (closed || queued >= pendingLimit || !message) return;
    const time = new Date();
    const line = formatTerminalLog(level, message, { now: time, color: false, fullLevel: true, label: project ? typeof config.log_align === "string" ? config.log_align : undefined : false }) + "\n";
    const exceptional = level === "error" || level === "fatal";
    queued++;
    tail = tail.then(async () => {
      if (await realpath(configured) !== directory) throw new Error("日志目录已变更。");
      const dailyFile = runtimeLogFilename("runtime", time);
      const writes = await Promise.allSettled([
        append(join(directory, dailyFile), line),
        ...(exceptional ? [append(join(directory, runtimeLogFilename("error", time)), line)] : []),
      ]);
      if (!closed && writes[0]?.status === "fulfilled" && dailyFile > lastLogDate) {
        lastLogDate = dailyFile;
        archiveWork = archiveWork.then(() => archiveRuntimeLogs(directory, dailyFile, archiveLifecycle.signal)).catch(() => {
          if (!archiveWarned && !archiveLifecycle.signal.aborted) warn("[日志] 无法归档旧运行日志。");
          archiveWarned = true;
        });
      }
      if (writes.some(({ status }) => status === "rejected")) throw new Error("本地日志写入失败。");
    }).catch(() => {
      if (!warned) warn("[日志] 无法写入本地日志。");
      warned = true;
    }).finally(() => { queued--; });
  }

  const originalConsole = { debug: console.debug, log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const method of Object.keys(consoleLevels) as (keyof typeof consoleLevels)[]) {
    const original = originalConsole[method];
    const level = consoleLevels[method];
    const proxy = (...args: unknown[]) => {
      const terminal = formatWithOptions({ colors: false, customInspect: false, getters: false }, ...args);
      const severity = formattedLogLevel(terminal, level);
      if (priorities.indexOf(severity) >= minimumLevel(config) || priorities.indexOf(severity) >= priorities.indexOf("warn"))
        withTerminalOutput(() => original.call(console, formatTerminalLog(severity, terminal, { label: typeof config.log_align === "string" ? config.log_align : undefined })));
      if (closed || queued >= pendingLimit || priorities.indexOf(severity) < minimumLevel(config) && priorities.indexOf(severity) < priorities.indexOf("warn")) return;
      try {
        const formatted = formatWithOptions({ colors: false, customInspect: false, getters: false }, ...args);
        enqueue(severity, sanitizeRuntimeLog(formatted.replace(/[\r\n]+/gu, " "), maxLength));
      } catch { return; }
    };
    console[method] = proxy;
    restorations.push(() => {
      if (console[method] === proxy) console[method] = original;
    });
  }

  return {
    writePluginLog(level: PluginLogLevel, message: string) {
      withTerminalOutput(() => originalConsole[compatibilityLevels[level]].call(console, formatTerminalLog(level, message, { label: false })));
      enqueue(level, message, false);
    },
    flush: () => tail,
    async close() {
      closed = true;
      archiveLifecycle.abort();
      for (const restore of restorations) restore();
      await tail;
      await archiveWork;
    },
  };
}
