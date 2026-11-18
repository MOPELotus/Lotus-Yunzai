import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProcessReceipts, type ProcessReceipt } from "../lib/process-receipts.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-process-receipts-"));
  temporary.push(path);
  const root = pathToFileURL(`${path}/`);
  return {
    root, path, directory: join(path, "data", "process-receipts"), receipts: createProcessReceipts(root),
  };
}

test("更新结果可单独领取，同一机器人原有重启回执得以保留", async () => {
  const { receipts } = await fixture();
  const target = { type: "group", botId: 99, id: 123 } as const;
  const at = Date.now();
  const restart = { kind: "restart", target, at } as const;
  const update = { kind: "update", result: "updated", revision: "a".repeat(40), target, at } as const;
  await Promise.all([receipts.save(restart), receipts.save(update)]);
  expect(await receipts.take(100, true)).toBeUndefined();
  expect(await receipts.take(99, true)).toEqual(update);
  expect(await receipts.take(99, true)).toBeUndefined();
  expect(await receipts.take(99)).toEqual(restart);
});

test("安装、更新与进程回执分槽存放，安装回执只由原账号或终端领取一次", async () => {
  const { directory, receipts, root } = await fixture();
  const at = Date.now();
  const target = { type: "private", botId: 99, id: 42 } as const;
  const restart = { kind: "restart", at, target } as const;
  const update = { kind: "update", result: "rolled-back", at, target } as const;
  const installed = { kind: "install", result: "installed", name: "图鉴-2.0", revision: "a".repeat(40), at, target } as const;
  const rolledBack = { kind: "install", result: "rolled-back", name: "工具", at, target: { type: "terminal" } } as const;
  await Promise.all([receipts.save(restart), receipts.save(update), receipts.save(installed), receipts.save(rolledBack)]);
  expect((await readdir(directory)).sort()).toEqual(["99.install.json", "99.json", "99.update.json", "terminal.install.json"]);

  const next = createProcessReceipts(root);
  expect(await next.take(100, "install")).toBeUndefined();
  expect(await next.take()).toBeUndefined();
  expect(await next.take(99, true)).toEqual(update);
  await next.discard(99);
  expect(await next.take(99)).toBeUndefined();
  const claims = await Promise.all([next.take(99, "install"), receipts.take(99, "install")]);
  expect(claims.filter(Boolean)).toEqual([installed]);
  expect(await next.take(undefined, "install")).toEqual(rolledBack);
  expect(await next.take(undefined, "install")).toBeUndefined();
});

test("同一机器人账号的 Milky、OneBot 与终端回执独立领取和清除", async () => {
  const { directory, receipts, root } = await fixture();
  const at = Date.now();
  const oneBot = { type: "private", botId: 99, id: 42 } as const;
  const milky = { ...oneBot, adapter: "milky" } as const;
  const restart = { kind: "restart", at, target: oneBot } as const;
  const milkyRestart = { ...restart, target: milky } as const;
  const update = { kind: "update", result: "rolled-back", at, target: oneBot } as const;
  const milkyUpdate = { ...update, target: milky } as const;
  const install = { kind: "install", result: "rolled-back", name: "工具", at, target: oneBot } as const;
  const milkyInstall = { ...install, target: milky } as const;
  const terminal = { ...restart, target: { type: "terminal" } } as const;

  await Promise.all([restart, milkyRestart, update, milkyUpdate, install, milkyInstall, terminal]
    .map((receipt) => receipts.save(receipt)));
  expect((await readdir(directory)).sort()).toEqual([
    "99.install.json", "99.json", "99.update.json", "milky-99.install.json", "milky-99.json", "milky-99.update.json", "terminal.json",
  ]);

  const next = createProcessReceipts(root);
  expect(await next.take(99)).toEqual(restart);
  expect(await next.take(99)).toBeUndefined();
  expect(await next.take(99, "milky")).toEqual(milkyRestart);
  await Promise.all([next.save(restart), next.save(milkyRestart)]);
  await next.discard(99, "milky");
  expect(await next.take(99, "milky")).toBeUndefined();
  expect(await next.take(99)).toEqual(restart);
  expect(await next.take()).toEqual(terminal);

  expect(await next.takeUpdate(99)).toEqual(update);
  expect(await next.takeUpdate(99, "milky")).toEqual(milkyUpdate);
  expect(await next.takeInstall(99)).toEqual(install);
  const claims = await Promise.all([receipts.takeInstall(99, "milky"), next.takeInstall(99, "milky")]);
  expect(claims.filter(Boolean)).toEqual([milkyInstall]);
  expect(await readdir(directory)).toEqual([]);
});

test("领取时拒绝适配器与文件名不一致或未识别的回执", async () => {
  const { directory, receipts } = await fixture();
  const at = Date.now();
  const target = { type: "masters", botId: 99, adapter: "milky" } as const;
  const scoped = { kind: "restart", at, target } as const;
  const unscoped = { ...scoped, target: { type: "masters", botId: 99 } } as const;
  const invalid = { ...scoped, target: { ...target, adapter: "onebot" } };
  const invalidTerminal = { ...scoped, target: { type: "terminal", adapter: "milky" } };
  for (const receipt of [invalid, invalidTerminal]) {
    await expect(receipts.save(receipt as ProcessReceipt)).rejects.toThrow("进程回执无效");
  }
  await expect(receipts.take(undefined, "milky")).rejects.toThrow("适配器无效");
  await expect(receipts.discard(99, "onebot" as "milky")).rejects.toThrow("适配器无效");

  await receipts.save(scoped);
  expect(await receipts.take(99, "milky")).toEqual(scoped);
  await writeFile(join(directory, "99.json"), JSON.stringify(scoped));
  await writeFile(join(directory, "milky-99.json"), JSON.stringify(unscoped));
  expect(await receipts.take(99)).toBeUndefined();
  expect(await receipts.take(99, "milky")).toBeUndefined();

  await writeFile(join(directory, "99.json"), JSON.stringify(unscoped));
  expect(await receipts.take(99)).toEqual(unscoped);
  await writeFile(join(directory, "99.json"), JSON.stringify(invalid));
  expect(await receipts.take(99)).toBeUndefined();
  expect(await readdir(directory)).toEqual([]);
});

test("安装回执拒绝不安全名称、错误修订号、主人组和错槽数据", async () => {
  const { directory, receipts } = await fixture();
  const at = Date.now();
  const target = { type: "private", botId: 99, id: 42 } as const;
  const receipt = { kind: "install", result: "installed", name: "工具", revision: "a".repeat(40), at, target } as const;
  for (const name of ["../工具", "a..b", "a/b", "工具\n", " x", "a".repeat(65)]) {
    await expect(receipts.save({ ...receipt, name })).rejects.toThrow("进程回执无效");
  }
  await expect(receipts.save({ ...receipt, revision: "abc123" })).rejects.toThrow("进程回执无效");

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "99.install.json"), JSON.stringify({ ...receipt, target: { type: "masters", botId: 99 } }));
  await writeFile(join(directory, "99.update.json"), JSON.stringify(receipt));
  expect(await receipts.take(99, "install")).toBeUndefined();
  expect(await receipts.take(99, true)).toBeUndefined();
  expect(await readdir(directory)).toEqual([]);
});

test("回执跨实例保存，终端与不同机器人的目标独立且只领取一次", async () => {
  const { directory, receipts, root } = await fixture();
  const at = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  const terminal = { kind: "stop", at, target: { type: "terminal" } } as const;
  const group = { kind: "restart", at, target: { type: "group", botId: 99, id: 123 } } as const;
  const privateChat = { kind: "stop", at, target: { type: "private", botId: 100, id: 456 } } as const;
  await Promise.all([receipts.save(terminal), receipts.save(group), receipts.save(privateChat)]);
  expect((await stat(join(directory, "99.json"))).mode & 0o077).toBe(0);

  const next = createProcessReceipts(root);
  expect(await next.take(98)).toBeUndefined();
  expect(await next.take(99)).toEqual(group);
  expect(await next.take(99)).toBeUndefined();
  expect(await next.take()).toEqual(terminal);
  expect(await next.take(100)).toEqual(privateChat);
  expect(await readdir(directory)).toEqual([]);
});

test("不同实例并发领取时只有一个成功，撤销失败尝试仅移除对应账号", async () => {
  const { receipts, root } = await fixture();
  const at = Date.now();
  const old = { kind: "restart", at, target: { type: "group", botId: 99, id: 123 } } as const;
  const current = { kind: "stop", at, target: { type: "private", botId: 99, id: 123 } } as const;
  const terminal = { kind: "stop", at, target: { type: "terminal" } } as const;
  const other = { kind: "restart", at, target: { type: "group", botId: 100, id: 123 } } as const;
  await receipts.save(old);
  await Promise.all([receipts.save(current), receipts.save(terminal), receipts.save(other)]);
  const claims = await Promise.all(Array.from({ length: 12 }, () => createProcessReceipts(root).take(99)));
  expect(claims.filter(Boolean)).toEqual([current]);

  await receipts.discard(100);
  await receipts.discard(100);
  expect(await receipts.take(100)).toBeUndefined();
  expect(await receipts.take()).toEqual(terminal);
});

test("发给主人组的回执按机器人存放且只持久化机器人账号", async () => {
  const { directory, receipts, root } = await fixture();
  const at = Date.now();
  await receipts.save({ kind: "restart", at, target: { type: "private", botId: 99, id: 42 } });
  const target = { type: "masters", botId: 99, id: 42, masterIds: [42] } as const;
  await receipts.save({ kind: "restart", at, target });
  const expected: ProcessReceipt = { kind: "restart", at, target: { type: "masters", botId: 99 } };
  expect(JSON.parse(await readFile(join(directory, "99.json"), "utf8"))).toEqual(expected);

  const next = createProcessReceipts(root);
  expect(await next.take()).toBeUndefined();
  expect(await next.take(100)).toBeUndefined();
  expect(await next.take(99)).toEqual(expected);
  expect(await next.take(99)).toBeUndefined();
  await expect(receipts.save({ kind: "restart", at, target: { type: "masters", botId: 0 } })).rejects.toThrow("进程回执无效");
});

test("目标错配、时间异常、损坏文件及符号链接均不产生回执", async () => {
  const { directory, path, receipts } = await fixture();
  const now = Date.now();
  const at = now - 31 * 24 * 60 * 60 * 1_000;
  await receipts.save({ kind: "stop", at, target: { type: "terminal" } });
  await receipts.save({ kind: "restart", at: now + 24 * 60 * 60 * 1_000, target: { type: "private", botId: 100, id: 42 } });
  await writeFile(join(directory, "99.json"), JSON.stringify({
    kind: "restart", at: now, target: { type: "private", botId: 100, id: 42 },
  }));
  await writeFile(join(directory, "101.json"), "invalid JSON");
  await writeFile(join(directory, "102.json"), JSON.stringify({
    kind: "restart", at: now, target: { type: "group", botId: 102, id: -42 },
  }));
  await writeFile(join(directory, "103.json"), " ".repeat(5_000));
  const outside = join(path, "outside.json");
  const outsideContents = JSON.stringify({ kind: "restart", at: now, target: { type: "private", botId: 104, id: 42 } });
  await writeFile(outside, outsideContents);
  await symlink(outside, join(directory, "104.json"));

  expect(await receipts.take()).toBeUndefined();
  for (const id of [99, 100, 101, 102, 103, 104]) expect(await receipts.take(id)).toBeUndefined();
  expect(await readdir(directory)).toEqual([]);
  expect(await readFile(outside, "utf8")).toBe(outsideContents);
});

test("无回执目录无需创建，非法参数或存放错误不会留下暂存数据", async () => {
  const { directory, receipts } = await fixture();
  expect(await receipts.take()).toBeUndefined();
  await receipts.discard();
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(receipts.take(0)).rejects.toThrow("机器人账号无效");
  await expect(receipts.discard(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow("机器人账号无效");
  await expect(receipts.save({ kind: "restart", at: 0, target: { type: "terminal" } })).rejects.toThrow("进程回执无效");

  const destination = join(directory, "terminal.json");
  await mkdir(destination, { recursive: true });
  const receipt: ProcessReceipt = { kind: "stop", at: Date.now(), target: { type: "terminal" } };
  await expect(receipts.save(receipt)).rejects.toThrow();
  expect(await readdir(directory)).toEqual(["terminal.json"]);
});
