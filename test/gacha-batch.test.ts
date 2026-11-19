import { expect, test } from "bun:test";
import { ProfileError } from "@lotus-yunzai/account";
import { HoyoRequestError, ZzzTuningRateLimitError } from "@lotus-yunzai/hoyo-client";
import { createGachaUpdater } from "../packages/gacha/update.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";
import { createGachaBatch, type GachaGame } from "../lib/gacha-batch.ts";
import type { MessageReply } from "../lib/messages.ts";
import { isUpdateCommand } from "../lib/update-command.ts";

const command = "#更新全部抽卡记录";
const alias = "#更新所有抽卡记录";
const progress = "[荷花插件]开始批量更新所有 profile 的原神/星铁/绝区零抽卡记录。";
const image = Uint8Array.of(1, 2, 3);

function context(normalizedMessage: string, replies: MessageReply[] = [], user_id: number | undefined = 42): MessageFallbackContext {
  return { message_type: "private", isMaster: false, user_id, isBotMaster: () => false, normalizedMessage,
    reply(message) { replies.push(message); return true; } };
}

test("keeps the original aliases and profile/game order, and reports independent failures in the original summary card", async () => {
  const calls: [string, number, GachaGame][] = [];
  const seen: unknown[] = [];
  const replies: MessageReply[] = [];
  const batch = createGachaBatch({
    listIds: async () => [2, 7], signal: new AbortController().signal,
    render: async (title, lead, rows) => { seen.push({ title, lead, rows }); return { png: image }; },
  });
  batch.register("gs", async (qq, id) => { calls.push([qq, id, "gs"]); return { uid: "100000002" }; });
  batch.register("sr", async (qq, id) => {
    calls.push([qq, id, "sr"]);
    if (id === 7) return { uid: "123456789" };
    throw new ProfileError("role-missing", "fixture-secret");
  });
  batch.register("zzz", async (qq, id) => {
    calls.push([qq, id, "zzz"]);
    if (id === 2) throw new ZzzTuningRateLimitError(200, 12);
    return undefined;
  });

  expect(await batch.fallback(command + "2", context(command + "2", replies))).toBeUndefined();
  expect(await batch.fallback(alias, context(alias, replies))).toEqual({ type: "image", file: image });
  expect(replies).toEqual([progress]);
  expect(calls).toEqual([
    ["42", 2, "gs"], ["42", 2, "sr"], ["42", 2, "zzz"], ["42", 7, "gs"], ["42", 7, "sr"], ["42", 7, "zzz"],
  ]);
  expect(seen).toEqual([{
    title: "全部抽卡记录", lead: "QQ 42\n部分失败 · 完成 3 项，跳过 2 项，失败 1 项。",
    rows: [
      "P2 原神：UID 100000002 · 完成", "P2 星铁：未绑定 UID，跳过", "P2 绝区零：失败：访问过于频繁，请稍后再试",
      "P7 原神：UID 100000002 · 完成", "P7 星铁：UID 123456789 · 完成", "P7 绝区零：已在更新，跳过",
    ],
  }]);
});

test("only exact batch aliases bypass Git management and batch and direct work share a profile slot", async () => {
  expect(isUpdateCommand(command)).toBe(false);
  expect(isUpdateCommand(alias)).toBe(false);
  expect(isUpdateCommand("#更新 全部抽卡记录")).toBe(true);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const updater = createGachaUpdater(async (qq, profileId) => {
    calls.push(`${qq}/${profileId}`);
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
      throw new Error("fixture");
    }
    return { uid: "100000002" };
  });
  const direct = updater("42", 1);
  await started.promise;
  expect(await updater("42", 1, () => calls.push("duplicate"))).toBeUndefined();
  expect(await updater("42", 2)).toEqual({ uid: "100000002" });
  release.resolve();
  await expect(direct).rejects.toThrow("fixture");
  expect(await updater("42", 1, () => calls.push("notify"))).toEqual({ uid: "100000002" });
  expect(calls).toEqual(["42/1", "42/2", "notify", "42/1"]);
});

test("returns distinct fixed auth and profile errors and retains every result if status rendering fails", async () => {
  const batch = createGachaBatch({
    listIds: async () => [3], signal: new AbortController().signal, render: async () => { throw Error("fixture-render"); },
  });
  batch.register("gs", async () => { throw new HoyoRequestError("api", "authkey=fixture-secret", 200, -100); });
  batch.register("sr", async () => { throw new ProfileError("changed", "fixture-profile-data"); });
  batch.register("zzz", async () => { throw new Error("fixture-transport-secret"); });
  expect(await batch.fallback(command, context(command))).toBe([
    "全部抽卡记录", "QQ 42", "部分失败 · 完成 0 项，跳过 0 项，失败 3 项。",
    "P3 原神：失败：登录凭据已失效，请刷新登录或重新扫码",
    "P3 星铁：失败：档案已变更，请重新发起", "P3 绝区零：失败：更新未完成，请稍后再试",
  ].join("\n"));
});

test("retired providers cannot remove their replacement and missing providers are counted as skips", async () => {
  const rendered: string[][] = [];
  const batch = createGachaBatch({
    listIds: async () => [1], signal: new AbortController().signal,
    render: async (_title, _lead, rows) => { rendered.push([...rows]); return { png: image }; },
  });
  const updater = async () => ({ uid: "100000002" });
  const old = batch.register("gs", updater);
  const replacement = batch.register("gs", updater);
  old();
  await batch.fallback(command, context(command));
  expect(rendered[0]).toEqual(["P1 原神：UID 100000002 · 完成", "P1 星铁：游戏插件未加载，跳过", "P1 绝区零：游戏插件未加载，跳过"]);
  replacement();
  await batch.fallback(command, context(command));
  expect(rendered[1]).toEqual(["P1 原神：游戏插件未加载，跳过", "P1 星铁：游戏插件未加载，跳过", "P1 绝区零：游戏插件未加载，跳过"]);
});

test("guards parallel batches from the same QQ and releases the slot after completion", async () => {
  const hold = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const startedIds: string[] = [];
  const batch = createGachaBatch({
    listIds: async () => [1], signal: new AbortController().signal, render: async () => ({ png: image }),
  });
  batch.register("gs", async (qq) => {
    startedIds.push(qq);
    if (qq === "42") { started.resolve(); await hold.promise; }
    return { uid: "100000002" };
  });
  const first = batch.fallback(command, context(command));
  await started.promise;
  expect(await batch.fallback(alias, context(alias))).toMatch(/正在批量更新/u);
  expect(await batch.fallback(command, context(command, [], 43))).toEqual({ type: "image", file: image });
  hold.resolve();
  expect(await first).toEqual({ type: "image", file: image });
  expect(await batch.fallback(command, context(command))).toEqual({ type: "image", file: image });
  expect(startedIds).toEqual(["42", "43", "42"]);
});

test("uses bounded forwarding nodes above 18 rows and keeps every profile visible", async () => {
  const batch = createGachaBatch({
    listIds: async () => [1, 2, 3, 4, 5, 7, 9], signal: new AbortController().signal,
    render: async () => { throw Error("large lists should not render"); },
  });
  const result = await batch.fallback(command, context(command));
  if (!result || typeof result !== "object" || !("type" in result) || result.type !== "forward") {
    throw new Error("expected a forwarded batch report");
  }
  expect(result.nodes[0]).toBe("全部抽卡记录\nQQ 42\n完成 · 完成 0 项，跳过 21 项，失败 0 项。");
  expect(String(result.nodes[1]).split("\n")).toHaveLength(18);
  expect(result.nodes[2]).toBe([
    "P9 原神：游戏插件未加载，跳过", "P9 星铁：游戏插件未加载，跳过", "P9 绝区零：游戏插件未加载，跳过",
  ].join("\n"));
});

test("reports empty archives without starting work and stops on abort before later providers", async () => {
  const empty = createGachaBatch({ listIds: async () => [], signal: new AbortController().signal });
  const replies: MessageReply[] = [];
  expect(await empty.fallback(command, context(command, replies))).toBe("[荷花插件]没有找到你的 profile。");
  expect(replies).toEqual([]);

  const controller = new AbortController();
  const calls: string[] = [];
  const batch = createGachaBatch({
    listIds: async () => [1, 2], signal: controller.signal,
    render: async () => { throw Error("abort should stop rendering"); },
  });
  batch.register("gs", async () => { calls.push("gs"); controller.abort(); return { uid: "100000002" }; });
  batch.register("sr", async () => { calls.push("sr"); return { uid: "123456789" }; });
  expect(await batch.fallback(command, context(command))).toBeUndefined();
  expect(calls).toEqual(["gs"]);
});
