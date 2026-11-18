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
