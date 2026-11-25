import { expect, test } from "bun:test";
import { ownOperationSession } from "../lib/own-operation-session.ts";

test("本人群会话按机器人、群、用户隔离，撤权和伪造身份不能继续", () => {
  const connection = new AbortController();
  const group = { message_type: "group", user_id: 42, self_id: 51, group_id: 61, message_id: 3, groupActivitySignal: connection.signal };
  const first = ownOperationSession(group)!;
  expect(first.user).toBe(42);
  expect(first.signal).toBe(connection.signal);
  expect(first.scope).not.toBe(ownOperationSession({ ...group, group_id: 62 })!.scope);
  expect(first.scope).not.toBe(ownOperationSession({ ...group, user_id: 43 })!.scope);
  for (const patch of [{ isDelegated: true }, { sub_type: "anonymous" }, { group_id: undefined }, { message_id: undefined },
    { groupActivitySignal: undefined }, { user_id: 51 }, { sender: { user_id: "43" } }]) {
    expect(ownOperationSession({ ...group, ...patch })).toBeUndefined();
  }
  connection.abort();
  expect(first.signal.aborted).toBe(true);
  expect(ownOperationSession(group)).toBeUndefined();
});

test("好友与群会话不串用，临时私聊及夹带群上下文不被授权", () => {
  const privateCredentialSignal = new AbortController().signal;
  const friend = { message_type: "private", user_id: 42, self_id: 51, privateCredentialSignal };
  expect(ownOperationSession(friend)?.scope).toBe("onebot:51:42");
  expect(ownOperationSession({ ...friend, sub_type: "group" })).toBeUndefined();
  expect(ownOperationSession({ ...friend, group_id: 61 })).toBeUndefined();
  expect(ownOperationSession({ ...friend, message_type: "group", group_id: 61, message_id: 1 })).toBeUndefined();
});
