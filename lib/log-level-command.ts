import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";

const command = /^#?(?:设置|修改)日志等级/u;
export const logLevels = ["trace", "debug", "info", "warn", "fatal", "mark", "error", "off"] as const;
export type LogLevel = typeof logLevels[number];

export function isLogLevelCommand(message: string) {
  return command.test(message);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (logLevels as readonly string[]).includes(value);
}

export function requestedLogLevel(message: string) {
  const value = message.replace(command, "").trim();
  return isLogLevel(value) ? value : undefined;
}

export function persistLogLevel(root: URL, level: LogLevel, canWrite: () => boolean, signal: AbortSignal,
  onCommitted?: () => void) {
  return updateLocalConfiguration(root, "bot", {
    canWrite, signal, onCommitted,
    prepare(content, current) {
      if (current.log_level === level) return { value: false };
      const document = parseDocument(content, { strict: true, uniqueKeys: true });
      if (document.errors.length || (document.contents && !isMap(document.contents))) {
        throw new GlobalConfigWriteError("config");
      }
      document.set("log_level", level);
      const yaml = document.toString({ lineWidth: 0 });
      if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...current, log_level: level })) {
        throw new GlobalConfigWriteError("config");
      }
      return { yaml, value: true };
    },
  });
}
