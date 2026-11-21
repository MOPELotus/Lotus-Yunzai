import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isLogLevelCommand, logLevels, persistLogLevel, requestedLogLevel } from "../lib/log-level-command.ts";

test("识别原设置和修改口令的可选井号、粘连参数及八个等级", () => {
  for (const level of logLevels) {
    expect(requestedLogLevel(`设置日志等级${level}`)).toBe(level);
    expect(requestedLogLevel(`#修改日志等级  ${level}`)).toBe(level);
  }
  expect(isLogLevelCommand("#日志 debug")).toBe(false);
  expect(requestedLogLevel("#设置日志等级 DEBUG")).toBeUndefined();
  expect(requestedLogLevel("#修改日志等级 error test")).toBeUndefined();
});

test("日志等级只写实际生效的 YAML，保留旧路径、软链和其他字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-log-level-config-"));
  const root = pathToFileURL(directory + "/");
  const legacy = join(directory, "config/config/bot.yaml");
  const primary = join(directory, "config/bot.yaml");
  const target = join(directory, "effective.yaml");
  const controller = new AbortController();
  try {
    await mkdir(join(directory, "config/config"), { recursive: true });
    await writeFile(legacy, "# 旧字段\nlog_level: info\nrestart_time: 5\n");
    expect(await persistLogLevel(root, "debug", () => true, controller.signal)).toBe(true);
    expect(await readFile(legacy, "utf8")).toContain("# 旧字段\nlog_level: debug\nrestart_time: 5\n");
    expect(await Bun.file(primary).exists()).toBe(false);
    await writeFile(target, "# 主字段\nlog_level: info\nlog_length: 200\n");
    await symlink("../effective.yaml", primary);
    expect(await persistLogLevel(root, "mark", () => true, controller.signal)).toBe(true);
    expect(await persistLogLevel(root, "mark", () => true, controller.signal)).toBe(false);
    expect(await readFile(target, "utf8")).toContain("# 主字段\nlog_level: mark\nlog_length: 200\n");

    let checks = 0;
    await expect(persistLogLevel(root, "off", () => ++checks === 1, controller.signal)).rejects.toThrow("permission");
    expect(await readFile(target, "utf8")).toContain("log_level: mark");
    expect(await readFile(legacy, "utf8")).toContain("log_level: debug");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
