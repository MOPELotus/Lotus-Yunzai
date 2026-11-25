import { expect, test } from "bun:test";
import { withGroupPersonalReplies } from "../lib/group-personal-replies.ts";
import type { MessageEvent, ReplyOptions } from "../lib/messages.ts";

test("群本人操作保留投递回调和原会话，回复及合并转发撤回但不撤回无关用户消息", async () => {
  const calls: { kind: string; options?: ReplyOptions }[] = [];
  const event = { message_type: "group", reply: async (_message: unknown, _quote?: boolean, options?: ReplyOptions) => {
    calls.push({ kind: "reply", options }); return true;
  }, forward: async (_nodes: unknown, _name?: string, options?: ReplyOptions) => {
    calls.push({ kind: "forward", options }); return true;
  } } as MessageEvent;
  let current = true;
  const wrapped = withGroupPersonalReplies(event, () => current);
  const onDelivered = () => {};
  await wrapped.reply("角色目录", true, { onDelivered });
  await wrapped.reply("二维码", false, { recallMsg: 30, recallOriginal: true });
  await wrapped.forward!(["排名"], "本人");
  expect(calls).toEqual([
    { kind: "reply", options: { recallMsg: 120, recallOriginal: false, onDelivered } },
    { kind: "reply", options: { recallMsg: 30, recallOriginal: false } },
    { kind: "forward", options: { recallMsg: 120, recallOriginal: false } },
  ]);
  current = false;
  expect(await wrapped.reply("过期会话")).toBe(false);
  expect(await wrapped.forward!(["过期会话"])).toBe(false);
  expect(calls).toHaveLength(3);
  expect(withGroupPersonalReplies({ ...event, message_type: "private" }, () => true).reply).toBe(event.reply);
});
