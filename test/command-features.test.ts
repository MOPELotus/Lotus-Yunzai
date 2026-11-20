import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CommandRegistry, sendCommandReply } from "../lib/commands.ts";
import { readGroupDispatch } from "../lib/group-dispatch.ts";
import type { MessageEvent } from "../lib/messages.ts";

const legacyLabel = "[Lotus-Plugin] Gacha Log";
const gachaLabel = "[gacha] 抽卡记录";
const group: MessageEvent = {
  msg: "*战绩", raw_message: "*战绩", message: "*战绩", post_type: "message", message_type: "group",
  isGroup: true, isPrivate: false, isMaster: false, self_id: 99, user_id: 42, group_id: 77, reply: () => true,
};

test("引用回复沿用原消息并将撤回选项交给当前协议", async () => {
  const sent: unknown[][] = [];
  const event = { reply: (...args: Parameters<MessageEvent["reply"]>) => { sent.push(args); return true; } };
  await sendCommandReply(event, { type: "quoted", message: "保留" });
  await sendCommandReply(event, { type: "quoted", message: "稍后撤回", options: { recallMsg: 20 } });
  expect(sent).toEqual([["保留", true], ["稍后撤回", true, { recallMsg: 20 }]]);
});

test("合并转发按指定批次和署名发送，结果未知时停止后续批次", async () => {
  const sent: { nodes: readonly unknown[]; senderName: string | undefined }[] = [];
  const fallback: unknown[] = [];
  await sendCommandReply({
    async forward(nodes, senderName) {
      sent.push({ nodes, senderName });
      if (sent.length === 3) throw new Error("未取得协议回执");
      return sent.length === 1;
    },
    reply(message) { fallback.push(message); return true; },
  }, { type: "forward", nodes: ["一", "二", "三", "四", "五", "六", "七"], batchSize: 2, senderName: "历史公告" });
  expect(sent).toEqual([
    { nodes: ["一", "二"], senderName: "历史公告" },
    { nodes: ["三", "四"], senderName: "历史公告" },
    { nodes: ["五", "六"], senderName: "历史公告" },
  ]);
  expect(fallback).toEqual(["三", "四", "合并转发结果未确认，请在聊天中核对。"]);
});

test("需要回执的模块回复只交给当前协议确认", async () => {
  const registry = new CommandRegistry();
  const delivered: number[] = [];
  registry.registerModule({
    name: "delivery-fixture",
    commands: {
      "#回执": (_, context) => {
        expect(context.message_id).toBe(88);
        return { type: "delivery", message: "回复", onDelivered: id => { delivered.push(id); } };
      },
    },
  });
  const reply = await registry.dispatch("#回执", { ...group, message_id: 88 });
  if (!reply) throw new Error("没有收到待确认的回复。");
  await sendCommandReply({ reply(message, quote, options) {
    expect(message).toBe("回复");
    expect(quote).toBe(false);
    expect(delivered).toEqual([]);
    options?.onDelivered?.(100);
    return true;
  } }, reply);
  expect(delivered).toEqual([100]);
});

test("当前群成员能力只传给原群消息的模块入口", async () => {
  const registry = new CommandRegistry();
  const read = async () => [{ id: 42 }];
  registry.registerModule({
    name: "roster-fixture", commands: {},
    async fallback(_message, context) {
      return context.listCurrentGroupMembers ? JSON.stringify(await context.listCurrentGroupMembers()) : "不可用";
    },
  });
  const route = (event: MessageEvent) => registry.dispatchFallback(event, () => true, () => false);
  const current = { ...group, listCurrentGroupMembers: read };
  expect(await route(current)).toBe('[{"id":42}]');
  expect(await route({ ...current, message_type: "private", isGroup: false, isPrivate: true })).toBe("不可用");
  expect(await route({ ...current, isDelegated: true })).toBe("不可用");
});

test("旧抽卡记录功能标签仅影响真正带该标签的入口", async () => {
  const registry = new CommandRegistry();
  const seen: string[] = [];
  registry.registerModule({
    name: "@lotus-yunzai/starrail", commands: {},
    fallbackFeatures: ({ normalizedMessage }) => normalizedMessage === "#星铁抽卡记录" ? [gachaLabel] : [],
    fallback(_message, { normalizedMessage }) { seen.push(normalizedMessage); return normalizedMessage; },
  });
  const disabled = (names: readonly string[]) => !names.includes(gachaLabel);
  const enabled = (names: readonly string[]) => names.includes(gachaLabel);
  const dispatch = (allowed: typeof disabled, command: string) => registry.dispatchFallback(group, allowed, () => false, command);
  expect(await dispatch(disabled, "#星铁战绩")).toBe("#星铁战绩");
  expect(await dispatch(disabled, "#星铁抽卡记录")).toBeUndefined();
  expect(await dispatch(enabled, "#星铁战绩")).toBeUndefined();
  expect(await dispatch(enabled, "#星铁抽卡记录")).toBe("#星铁抽卡记录");
  expect(seen).toEqual(["#星铁战绩", "#星铁抽卡记录"]);
});

test("旧配置选择器匹配当前模块名称，禁用优先且保持其他功能可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-feature-names-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "group.yaml"), Bun.YAML.stringify({
      "77": { disable: [legacyLabel, "[Lotus-Plugin] Profile Settings", "复读"] },
      "78": { enable: ["[Lotus-Plugin] Checkin Admin", "[Lotus-Plugin] Music", "复读"] },
      "79": { enable: [gachaLabel], disable: [legacyLabel] },
      "80": { disable: ["genshin-inventory"] },
      "81": { enable: ["genshin-world-boss-kill-count-inventory"] },
    }));
    const { allows } = await readGroupDispatch(pathToFileURL(`${root}/`));
    expect(allows(group, [gachaLabel])).toBe(false);
    expect(allows(group, ["@lotus-yunzai/cloud-profile"])).toBe(false);
    expect(allows(group, ["@lotus-yunzai/checkin-group-registration"])).toBe(false);
    expect(allows(group, ["@lotus-yunzai/starrail"])).toBe(true);
    expect(allows(group, ["主动复读"])).toBe(false);
    expect(allows(group, ["自动复读"])).toBe(true);
    expect(allows({ ...group, group_id: 78 }, ["主动复读"])).toBe(true);
    expect(allows({ ...group, group_id: 78 }, ["@lotus-yunzai/checkin-roster"])).toBe(true);
    expect(allows({ ...group, group_id: 78 }, ["[media] 点歌"])).toBe(true);
    expect(allows({ ...group, group_id: 78 }, ["[media] B 站解析"])).toBe(false);
    expect(allows({ ...group, group_id: 79 }, [gachaLabel])).toBe(false);
    expect(allows({ ...group, group_id: 80 }, ["[genshin] 背包"])).toBe(false);
    expect(allows({ ...group, group_id: 80 }, ["[genshin] 世界 BOSS"])).toBe(true);
    expect(allows({ ...group, group_id: 80 }, ["@lotus-yunzai/genshin"])).toBe(true);
    expect(allows({ ...group, group_id: 81 }, ["[genshin] 世界 BOSS"])).toBe(true);
    expect(allows({ ...group, group_id: 81 }, ["[genshin] 背包"])).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
