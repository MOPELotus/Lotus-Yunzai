import { expect, test } from "bun:test";
import { milkyMessage } from "../lib/adapters/milky-message.ts";

const selfId = 1001;
const userId = 2002;
const groupId = 3003;
const offline = async () => undefined;

function envelope(scene: "friend" | "group", profile?: unknown) {
  return {
    self_id: selfId, event_type: "message_receive",
    data: {
      message_scene: scene, sender_id: userId, peer_id: scene === "group" ? groupId : userId, message_seq: 1,
      segments: [{ type: "text", data: { text: "#状态" } }],
      ...(scene === "group" ? { group_member: profile } : { friend: profile }),
    },
  };
}

test("Milky 只从匹配会话与发送者的成员资料读取昵称、名片和群角色", () => {
  for (const role of ["member", "admin", "owner"]) {
    const event = milkyMessage(envelope("group", {
      user_id: userId, group_id: groupId, nickname: "昵称", card: "群名片", role,
    }), selfId, offline);
    expect(event).toMatchObject({
      sender: { user_id: userId, nickname: "昵称", card: "群名片", role },
      member: { is_admin: role === "admin", is_owner: role === "owner" },
      isMaster: false, boundAccount: false,
    });
  }

  for (const profile of [
    { user_id: selfId, group_id: groupId, role: "owner", nickname: "他人" },
    { user_id: userId, group_id: groupId + 1, role: "owner", nickname: "他群" },
    { user_id: String(userId), group_id: groupId, role: "owner" },
    { user_id: userId, role: "owner", card: "群号未知" },
    { user_id: userId, group_id: groupId, role: "master", nickname: "坏\n名", card: "x".repeat(257) },
  ]) {
    const event = milkyMessage(envelope("group", profile), selfId, offline);
    expect(event?.sender).toEqual({ user_id: userId });
    expect(event?.member).toBeUndefined();
  }
});

test("Milky 好友资料匹配 QQ 后保留昵称与备注，群角色不会进入私聊", () => {
  const event = milkyMessage(envelope("friend", { user_id: userId, nickname: "好友", remark: "备注", role: "owner" }), selfId, offline);
  expect(event?.sender).toEqual({ user_id: userId, nickname: "好友", remark: "备注" });
  expect(event?.member).toBeUndefined();
  expect(milkyMessage(envelope("friend", { user_id: selfId, nickname: "他人" }), selfId, offline)?.sender)
    .toEqual({ user_id: userId });
});

test("Milky 按目标群查询消息发送者的角色并核对 API 返回身份", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const target = 4004;
  let result: Record<string, unknown> | undefined = { member: { group_id: target, user_id: userId, role: "admin" } };
  const event = milkyMessage(envelope("friend"), selfId, async (action, params) => {
    calls.push({ action, params });
    return result;
  });
  expect(await event?.getGroupRole?.(0)).toBeUndefined();
  expect(await event?.getGroupRole?.(2 ** 53)).toBeUndefined();
  expect(calls).toHaveLength(0);
  expect(await event?.getGroupRole?.(target)).toBe("admin");
  expect(calls).toEqual([{
    action: "get_group_member_info", params: { group_id: target, user_id: userId, no_cache: true },
  }]);
  for (const member of [
    { group_id: target, user_id: selfId, role: "owner" },
    { group_id: groupId, user_id: userId, role: "owner" },
    { group_id: target, user_id: userId, role: "master" },
    { group_id: target, role: "owner" },
  ]) {
    result = { member };
    expect(await event?.getGroupRole?.(target)).toBeUndefined();
  }
  result = undefined;
  expect(await event?.getGroupRole?.(target)).toBeUndefined();

  const broken = milkyMessage(envelope("group"), selfId, async () => { throw new Error("离线"); });
  expect(await broken?.getGroupRole?.(target)).toBeUndefined();
});
