import { expect, test } from "bun:test";
import {
  ownerContactListCommand, ownerContactListSession, replyOwnerContactList, type OwnerContactListSession,
} from "../lib/owner-contact-list.ts";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";

test("联系人名单在读取到发送之间复核主人、会话和当前连接", async () => {
  let owner = true;
  const controller = new AbortController();
  let lookup = Promise.withResolvers<readonly { id: number; name?: string }[]>();
  const sent: MessageReply[] = [];
  let reads = 0;
  const session: OwnerContactListSession = {
    botId: 99, ownerId: 42, signal: controller.signal,
    authorized: () => owner,
    groups: () => { reads++; return lookup.promise; },
    friends: async () => [],
    async forward(nodes) { sent.push(...nodes); return "confirmed"; },
    async reply(text) { sent.push(text); return "confirmed"; },
  };
  const event: MessageEvent = {
    msg: "#群列表", raw_message: "#群列表", message: [],
    post_type: "message", message_type: "private", sub_type: "friend", self_id: 99, user_id: 42,
    isPrivate: true, isGroup: false, isMaster: true, reply: () => false,
    [ownerContactListSession]: session,
  };
  const command = ownerContactListCommand(event.msg)!;
  for (const change of [
    { isDelegated: true }, { self_id: 101 }, { user_id: 43 },
    { sub_type: "group" }, { message_type: "group" as const },
  ]) {
    await replyOwnerContactList({ ...event, ...change }, command);
  }
  expect(reads).toBe(0);

  const revoked = replyOwnerContactList(event, command);
  owner = false;
  lookup.resolve([{ id: 80, name: "隐私样本" }]);
  await revoked;
  expect(reads).toBe(1);
  expect(sent).toEqual([]);

  owner = true;
  lookup = Promise.withResolvers();
  const disconnected = replyOwnerContactList(event, command);
  controller.abort();
  lookup.resolve([{ id: 81, name: "更换连接后不可发送" }]);
  await disconnected;
  expect(reads).toBe(2);
  expect(sent).toEqual([]);
});
