import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { archiveRuntimeLogs } from "../lib/runtime-log-archive.ts";
import { attachRuntimeLog } from "../lib/runtime-log-writer.ts";
import { readRuntimeLogs, runtimeLogFilename, sanitizeRuntimeLog } from "../lib/runtime-logs.ts";

const time = new Date(2026, 0, 3, 0, 7);

async function fixture(run: (root: URL, directory: string, logs: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-runtime-log-"));
  try {
    const logs = join(directory, "logs");
    await mkdir(logs);
    await run(pathToFileURL(`${directory}/`), directory, logs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("只读取服务端本地日期的运行日志和固定错误日志，稳定末行可无换行", () => fixture(async (root, _directory, logs) => {
  expect(runtimeLogFilename("runtime", time)).toBe("command.2026-01-03.log");
  expect(runtimeLogFilename("error", time)).toBe("error.log");
  expect(await readRuntimeLogs(root, "runtime", { limit: 10 }, time)).toEqual([]);
  await writeFile(join(logs, "command.2026-01-02.log"), "前一天\n");
  await writeFile(join(logs, "command.2026-01-03.log"), "旧\r\n\n新版\n最后一条");
  await writeFile(join(logs, "error.log"), "错误旧\n错误新\n");
  expect(await readRuntimeLogs(root, "runtime", { limit: 2 }, time)).toEqual(["最后一条", "新版"]);
  expect(await readRuntimeLogs(root, "error", { limit: 10 }, time)).toEqual(["错误新", "错误旧"]);
  expect(await readRuntimeLogs(root, "error", { limit: 0 }, time)).toEqual([]);
}));

test("去除 ANSI 和控制符，隐藏常见凭据格式且可安全重复脱敏", () => {
  const raw = [
    '\x1b[31m[ERROR]\x1b[0m\u202e {"Cookie":"fake_cookie=value; unknown=fake_extra", "event":"ok"}',
    '{"accessToken":"fake_token", "password":"fake spaced \\"value\\" end", "note":"ok"}',
    "请求 https://name:fake_uri@example.invalid/?authkey=fake_auth%2Bvalue&safe=1",
    "stoken_v2=fake_stoken; ltoken=fake_ltoken; ignore=ok",
    "--api-key fake_cli --foo normal",
    "\x1b]8;;https://example.invalid\x07Authorization: Bearer fake_bearer\x1b]8;;\x07",
    "basic ZmFrZTpwYXNz external",
    "token=%61%62%63&name=ok",
  ];
  const sanitized = raw.map((line) => sanitizeRuntimeLog(line));
  for (const [index, line] of sanitized.entries()) {
    expect(line).not.toMatch(/fake_|fake spaced|ZmFrZTpwYXNz|%61%62%63|[\x00-\x1f\u202e]/u);
    expect(line).toContain("[已隐藏]");
    expect(sanitizeRuntimeLog(line)).toBe(line);
    expect(line.length).toBeLessThan(raw[index]!.length + 16);
  }
  expect(sanitized[0]).toContain('"event":"ok"');
  expect(sanitized[1]).toContain('"note":"ok"');
  expect(sanitized[2]).toContain("&safe=1");
  expect(sanitizeRuntimeLog("😀😀xx", 3)).toBe("😀…");
  expect(sanitizeRuntimeLog("😀😀xx", 2)).toBe("…");
});

test("筛选对脱敏后的内容做字面匹配，最多 1000 条", () => fixture(async (root, _directory, logs) => {
  const file = join(logs, "error.log");
  await writeFile(file, "a [literal] .*\nordinary\nCookie: literal-secret=very-rare\npassword: xyz-only-existing\n");
  expect(await readRuntimeLogs(root, "error", { limit: 100, search: ".*" }, time)).toEqual(["a [literal] .*"]);
  expect(await readRuntimeLogs(root, "error", { limit: 100, search: "xyz-only-existing" }, time)).toEqual([]);
  expect(await readRuntimeLogs(root, "error", { limit: 100, search: "very-rare" }, time)).toEqual([]);
  expect(await readRuntimeLogs(root, "error", { limit: 100, search: "已隐藏" }, time)).toHaveLength(2);
  await writeFile(file, Array.from({ length: 1005 }, (_, index) => `entry${index}\n`).join(""));
  const tail = await readRuntimeLogs(root, "error", { limit: 2000 }, time);
  expect(tail).toHaveLength(1000);
  expect(tail[0]).toBe("entry1004");
  expect(tail.at(-1)).toBe("entry5");
}));

test("只读有界尾部，跳过窗口开头的半个 UTF-8 词条和非法 UTF-8 行", () => fixture(async (root, _directory, logs) => {
  const file = join(logs, "error.log");
  const huge = "跨".repeat(Math.ceil((4 * 1024 * 1024) / 3));
  const valid = "新版😀";
  await writeFile(file, Buffer.concat([
    Buffer.from(`较早敏感词\n始端 ${huge} 假秘密\n`), Buffer.from([0xff, 0x0a]),
    Buffer.from(`${valid}\n${"长".repeat(2_100)}\n`),
  ]));
  const output = await readRuntimeLogs(root, "error", { limit: 10 }, time);
  expect(output).toEqual([`${"长".repeat(1999)}…`, valid]);
  expect(await readRuntimeLogs(root, "error", { limit: 10, search: "较早敏感词" }, time)).toEqual([]);
  expect(await readRuntimeLogs(root, "error", { limit: 10, search: "假秘密" }, time)).toEqual([]);
}));

test("拒绝符号链接逃出日志目录或宿主目录", () => fixture(async (root, directory, logs) => {
  const privateFile = join(directory, "local-sensitive.log");
  await writeFile(privateFile, "不应读取\n");
  const error = join(logs, "error.log");
  await symlink(privateFile, error);
  await expect(readRuntimeLogs(root, "error", { limit: 10 }, time)).rejects.toThrow("无法安全读取运行日志");
  await rm(error);
  const outside = await mkdtemp(join(tmpdir(), "lotus-runtime-log-external-"));
  const another = join(directory, "nested");
  await mkdir(another);
  try {
    await writeFile(join(outside, "error.log"), "不应读取\n");
    await symlink(outside, join(another, "logs"));
    await expect(readRuntimeLogs(pathToFileURL(`${another}/`), "error", { limit: 10 }, time)).rejects.toThrow("无法安全读取运行日志");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}));

test("日志写入固定启动时的内部软链目录，运行中改指及外部链接拒绝写入", () => fixture(async (root, directory, logs) => {
  await rm(logs, { recursive: true });
  await mkdir(join(directory, "stored-logs"));
  await mkdir(join(directory, "other-logs"));
  await symlink("stored-logs", logs);
  const writer = await attachRuntimeLog(root, {});
  try {
    writer.writePluginLog("error", "保留在原日志目录");
    await writer.flush();
    const before = await readFile(join(directory, "stored-logs/error.log"), "utf8");
    expect(before).toContain("保留在原日志目录");

    await rm(logs);
    await symlink("other-logs", logs);
    writer.writePluginLog("error", "切换后拒绝写入");
    await writer.flush();
    expect(await readdir(join(directory, "other-logs"))).toEqual([]);
    expect(await readFile(join(directory, "stored-logs/error.log"), "utf8")).toBe(before);
  } finally {
    await writer.close();
  }

  for (const target of [".", ".."]) {
    await rm(logs);
    await symlink(target, logs);
    await expect(attachRuntimeLog(root, {})).rejects.toThrow("日志目录须位于宿主目录内");
  }
}));

test("旧运行日志跨日压缩并按日期保留 180 份，保留当前日志和固定错误日志", () => fixture(async (root, directory, logs) => {
  const body = Buffer.from("上一天的中文日志\n".repeat(100));
  const old = join(logs, "command.2026-01-02.log");
  const today = join(logs, "command.2026-01-03.log");
  const error = join(logs, "error.log");
  const archives = Array.from({ length: 181 }, (_, index) =>
    `command.${new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10)}.log.gz`);
  for (const name of archives) await writeFile(join(logs, name), gzipSync(name));
  await writeFile(old, body);
  await writeFile(today, "本日内容\n");
  await writeFile(error, "错误内容\n");
  const external = join(directory, "private.log");
  const symbolic = join(logs, "command.2026-01-01.log");
  await writeFile(external, "目录以外的文件");
  await symlink(external, symbolic);
  await writeFile(join(logs, "command.2025-02-30.log.gz"), "自定义文件");

  await archiveRuntimeLogs(logs, runtimeLogFilename("runtime", time));
  expect(gunzipSync(await readFile(old + ".gz"))).toEqual(body);
  expect((await lstat(old + ".gz")).mode & 0o777).toBe(0o600);
  await expect(readFile(old)).rejects.toMatchObject({ code: "ENOENT" });
  for (const name of archives.slice(0, 2)) await expect(readFile(join(logs, name))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(logs)).toHaveLength(184);
  expect((await lstat(symbolic)).isSymbolicLink()).toBe(true);
  expect(await readFile(external, "utf8")).toBe("目录以外的文件");
  expect(await readRuntimeLogs(root, "runtime", { limit: 10 }, time)).toEqual(["本日内容"]);
  expect(await readRuntimeLogs(root, "error", { limit: 10 }, time)).toEqual(["错误内容"]);

  await writeFile(old, "晚到记录");
  await archiveRuntimeLogs(logs, runtimeLogFilename("runtime", time));
  expect(await readFile(old, "utf8")).toBe("晚到记录");
  expect(gunzipSync(await readFile(old + ".gz"))).toEqual(body);
}));
