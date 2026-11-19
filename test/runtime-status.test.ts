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
