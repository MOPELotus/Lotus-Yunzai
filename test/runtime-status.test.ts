import { expect, test } from "bun:test";
import type { CommandContext } from "../lib/commands.ts";
import { createRuntimeStatus } from "../lib/runtime-status.ts";

const onebot = { id: 99, adapter: "onebot" as const, seconds: 15 };
const milky = { id: 99, adapter: "milky" as const, seconds: 2 };
const secondBot = { id: 100, adapter: "onebot" as const, seconds: 42 };
const privateMessage: CommandContext = { message_type: "private", isMaster: false, self_id: 99, user_id: 51 };

test("状态卡仅投影当前适配器，双连接不借用另一协议的统计", async () => {
  const calls: string[] = [];
  const status = createRuntimeStatus({
    accounts: () => [onebot, milky, secondBot],
    countImages: true,
    loadedNames: () => ["system", "group", "local.js"],
    async readCounts(kind, scope, bucket) {
      calls.push(`${kind}:${scope}:${bucket}`);
      return { send: "4", receive: "7" };
    },
  });
  expect(await status({ ...privateMessage, isMaster: true }, true)).toBeUndefined();
  expect(await status({ ...privateMessage, runtimeStatusScope: "milky" }, true)).toBeUndefined();
  expect(await status({ ...privateMessage, runtimeStatusScope: "milky", runtimeDiagnosticsScope: "milky" }, true)).toEqual({
    accounts: [{ adapter: "milky", name: "Milky", seconds: 2 }], pluginCount: 2, scriptCount: 1,
  });
  expect(await status({ ...privateMessage, runtimeStatusScope: "onebot", message_type: "group", isMaster: true }, true)).toBeUndefined();
  expect(await status({ ...privateMessage, runtimeStatusScope: "onebot", self_id: 100, message_type: "group" }, false)).toEqual({
    accounts: [{ adapter: "onebot", name: "OneBot", seconds: 42, sent: "4", received: "7", images: "4" }],
  });
  expect(calls).toEqual(["msg:bot:100:total", "image:bot:100:total"]);
});

test("状态卡读取统计期间断线会停止，Valkey 读取失败仍可展示在线状态", async () => {
  let connected = true;
  let fail = false;
  const status = createRuntimeStatus({
    accounts: () => connected ? [onebot] : [],
    countImages: false,
    loadedNames: () => undefined,
    async readCounts() {
      connected = fail;
      if (fail) throw new Error("fixture");
      return { send: "4", receive: "7" };
    },
  });
  const scoped = { ...privateMessage, runtimeStatusScope: "onebot", isMaster: true } as const;
  expect(await status(scoped, true)).toBeUndefined();
  connected = true;
  fail = true;
  expect(await status(scoped, true)).toEqual({ accounts: [{ adapter: "onebot", name: "OneBot", seconds: 15 }] });
  expect(await status({ ...scoped, isDelegated: true }, true)).toBeUndefined();
});

test("Redis 明细只为已授权的 Pro 读取，剔除配置、进程标识和键名", async () => {
  let calls = 0;
  const status = createRuntimeStatus({
    accounts: () => [onebot],
    readCounts: async () => ({ send: "0", receive: "0" }),
    countImages: false,
    loadedNames: () => undefined,
    async readRedisStatus(signal) {
      expect(signal.aborted).toBe(false);
      calls++;
      return ["# Server", "redis_version:7.2.0", "valkey_version:8.1.1", "process_id:42",
        "config_file:/secret/redis.conf", "host:internal.example", "used_memory:1024", "used_memory_peak:2048",
        "connected_clients:2", "db0:keys=5,expires=3,avg_ttl=2000", "db1:keys=NaN,expires=0,avg_ttl=0"].join("\r\n");
    },
  });
  const group = { ...privateMessage, runtimeStatusScope: "onebot", message_type: "group", isMaster: true } as const;
  expect((await status(group, false))?.redis).toBeUndefined();
  expect(await status(group, true)).toBeUndefined();
  const owner = { ...privateMessage, runtimeStatusScope: "onebot", isMaster: true } as const;
  expect((await status(owner, true))?.redis).toMatchObject({
    version: "8.1.1", usedMemory: 1024, peakMemory: 2048, clients: 2,
    databases: [{ index: 0, keys: 5, expires: 3, averageTtl: 2000 }],
  });
  const model = await status(owner, true);
  expect(JSON.stringify(model)).not.toMatch(/secret|internal\.example|process_id/u);
  expect(calls).toBe(2);
});
