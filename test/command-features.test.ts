import { expect, test } from "bun:test";
import { CommandRegistry, sendCommandReply } from "../lib/commands.ts";
import type { MessageEvent } from "../lib/messages.ts";

const legacyLabel = "[Lotus-Plugin] Gacha Log";
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

test("旧抽卡记录功能标签仅影响真正带该标签的入口", async () => {
  const registry = new CommandRegistry();
  const seen: string[] = [];
  registry.registerModule({
    name: "@lotus-yunzai/starrail", commands: {},
    fallbackFeatures: ({ normalizedMessage }) => normalizedMessage === "#星铁抽卡记录" ? [legacyLabel] : [],
    fallback(_message, { normalizedMessage }) { seen.push(normalizedMessage); return normalizedMessage; },
  });
  const disabled = (names: readonly string[]) => !names.includes(legacyLabel);
  const enabled = (names: readonly string[]) => names.includes(legacyLabel);
  const dispatch = (allowed: typeof disabled, command: string) => registry.dispatchFallback(group, allowed, () => false, command);
  expect(await dispatch(disabled, "#星铁战绩")).toBe("#星铁战绩");
  expect(await dispatch(disabled, "#星铁抽卡记录")).toBeUndefined();
  expect(await dispatch(enabled, "#星铁战绩")).toBeUndefined();
  expect(await dispatch(enabled, "#星铁抽卡记录")).toBe("#星铁抽卡记录");
  expect(seen).toEqual(["#星铁战绩", "#星铁抽卡记录"]);
});
