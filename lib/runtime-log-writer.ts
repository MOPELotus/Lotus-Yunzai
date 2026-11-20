import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatWithOptions, inspect, types } from "node:util";
import { archiveRuntimeLogs } from "./runtime-log-archive.ts";
import { runtimeLogFilename, sanitizeRuntimeLog } from "./runtime-logs.ts";

const priorities = ["trace", "debug", "info", "warn", "error", "fatal", "off"];
const consoleLevels = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;
const pendingLimit = 512;
const defaultLabel = "Lotus-Yunzai";

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

export function createPluginLog(config: Readonly<Record<string, unknown>>,
  write: (level: PluginLogLevel, message: string) => void = (level, message) => console[compatibilityLevels[level]](message)) {
  const minimum = minimumLevel(config);
  const limit = configuredLogLength(config.log_length) ?? 10_000;
  const setting = config.log_object;
  const objectOptions = setting && typeof setting === "object" ? setting as Record<string, unknown> : {};
  const partLimit = configuredLogLength(objectOptions.length) ?? limit;
  const boundedNumber = (value: unknown, maximum: number) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;
  const options = { colors: false, customInspect: false, getters: false, showHidden: false, showProxy: false,
    depth: boundedNumber(objectOptions.depth, 10), maxArrayLength: boundedNumber(objectOptions.maxArrayLength, 100),
    maxStringLength: boundedNumber(objectOptions.maxStringLength, 1_000) } as const;
  const label = typeof config.log_align === "string" ? sanitizeRuntimeLog(config.log_align, 64) : defaultLabel;
  const projectLabel = /^(?:TRSSYz|TRSS-Yunzai)$/iu.test(label.trim()) ? label.replace(label.trim(), defaultLabel) : label;

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
    if (severity >= 0 && severity < priorities.indexOf("warn") && severity < minimum) return;
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
  const directory = join(await realpath(fileURLToPath(root)), "logs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error("日志目录须位于宿主目录内。");

  const minimum = minimumLevel(config);
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

  function enqueue(level: PluginLogLevel, message: string) {
    if (closed || queued >= pendingLimit || !message) return;
    const time = new Date();
    const line = `${time.toISOString()} [${level.toUpperCase()}] ${message}\n`;
    const exceptional = level === "error" || level === "fatal";
    queued++;
    tail = tail.then(async () => {
      if (await realpath(directory) !== directory) throw new Error("日志目录已变更。");
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
    if (priorities.indexOf(level) < minimum) continue;
    const proxy = (...args: unknown[]) => {
      original.apply(console, args);
      if (closed || queued >= pendingLimit) return;
      try {
        const formatted = formatWithOptions({ colors: false, customInspect: false, getters: false }, ...args);
        enqueue(level, sanitizeRuntimeLog(formatted.replace(/[\r\n]+/gu, " "), maxLength));
      } catch { return; }
    };
    console[method] = proxy;
    restorations.push(() => {
      if (console[method] === proxy) console[method] = original;
    });
  }

  return {
    writePluginLog(level: PluginLogLevel, message: string) {
      originalConsole[compatibilityLevels[level]].call(console, message);
      enqueue(level, message);
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
