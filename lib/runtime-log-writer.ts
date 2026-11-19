import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatWithOptions } from "node:util";
import { archiveRuntimeLogs } from "./runtime-log-archive.ts";
import { runtimeLogFilename, sanitizeRuntimeLog } from "./runtime-logs.ts";

const priorities = ["trace", "debug", "info", "warn", "error", "fatal", "off"];
const consoleLevels = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;
const pendingLimit = 512;

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

  const configuredLevel = typeof config.log_level === "string" ? priorities.indexOf(config.log_level.toLowerCase()) : -1;
  const minimum = configuredLevel < 0 ? priorities.indexOf("info") : configuredLevel;
  const configuredLength = Number(config.log_length);
  const maxLength = Number.isSafeInteger(configuredLength) && configuredLength > 0
    ? Math.min(configuredLength, 32_000) : 10_000;
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

  for (const method of Object.keys(consoleLevels) as (keyof typeof consoleLevels)[]) {
    const original = console[method];
    const level = consoleLevels[method];
    if (priorities.indexOf(level) < minimum) continue;
    const proxy = (...args: unknown[]) => {
      original.apply(console, args);
      if (closed || queued >= pendingLimit) return;

      let message: string;
      try {
        const formatted = formatWithOptions({ colors: false, customInspect: false, getters: false }, ...args);
        message = sanitizeRuntimeLog(formatted.replace(/[\r\n]+/gu, " "), maxLength);
      } catch {
        return;
      }
      if (!message) return;
      const time = new Date();
      const line = `${time.toISOString()} [${level.toUpperCase()}] ${message}\n`;
      queued++;
      tail = tail.then(async () => {
        if (await realpath(directory) !== directory) throw new Error("日志目录已变更。");
        const dailyFile = runtimeLogFilename("runtime", time);
        const writes = await Promise.allSettled([
          append(join(directory, dailyFile), line),
          ...(level === "error" ? [append(join(directory, runtimeLogFilename("error", time)), line)] : []),
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
    };
    console[method] = proxy;
    restorations.push(() => {
      if (console[method] === proxy) console[method] = original;
    });
  }

  return {
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
