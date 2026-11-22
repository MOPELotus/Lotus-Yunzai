import { expect, test } from "bun:test";
import { OneBotCalls, OneBotNotSentError, type OneBotAction } from "../lib/adapters/onebot-calls.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";
import { segment } from "../lib/messages.ts";

function connection() {
  const calls = new OneBotCalls();
  const frames: OneBotAction[] = [];
  const send = (frame: OneBotAction) => { frames.push(frame); return true; };
  function confirm(frame: OneBotAction, status = "ok", retcode = 0) {
    calls.receive({ echo: frame.echo, status, retcode });
  }
  return { calls, send, frames, confirm };
}

test("私聊按当前绑定账号发送，使用与群发一致的消息编码并等待 echo 确认", async () => {
  const groups = new OneBotGroups();
  const old = connection();
  const current = connection();
  const other = connection();
  const detachOld = groups.connect(99, old);
  groups.connect(100, other);
  groups.connect(99, current);
  detachOld();

  const sent = groups.sendPrivate(99, 42, [segment.text("测试"), segment.face(5)]);
  expect(current.frames).toHaveLength(1);
  const frame = current.frames[0]!;
  expect(frame).toMatchObject({ action: "send_msg", params: {
    message_type: "private", user_id: 42, auto_escape: true, message: [
      { type: "text", data: { text: "测试" } }, { type: "face", data: { id: "5" } },
    ],
  } });
  expect(frame.echo).toBeTypeOf("string");
  expect(old.frames).toEqual([]);
  expect(other.frames).toEqual([]);
  expect("sendPrivate" in groups.transport()).toBe(false);

  other.confirm(frame);
  current.confirm(frame, "failed", 100);
  expect(await sent).toBe(false);

  const confirmed = groups.sendPrivate(99, 42, "确认");
  current.confirm(current.frames[1]!);
  expect(await confirmed).toBe(true);
});

test("失去确认返回 false，未连接和无效收件人或内容明确报未发送", async () => {
  const groups = new OneBotGroups();
  const current = connection();
  const detach = groups.connect(99, current);

  await expect(groups.sendPrivate(100, 42, "离线")).rejects.toBeInstanceOf(OneBotNotSentError);
  await expect(groups.sendPrivate(99, 0, "无效收件人")).rejects.toBeInstanceOf(OneBotNotSentError);
  await expect(groups.sendPrivate(99, 42, [])).rejects.toBeInstanceOf(OneBotNotSentError);
  expect(current.frames).toEqual([]);

  const sent = groups.sendPrivate(99, 42, "未确认");
  expect(current.frames).toHaveLength(1);
  current.calls.close();
  detach();
  expect(await sent).toBe(false);
  await expect(groups.sendPrivate(99, 42, "离线")).rejects.toBeInstanceOf(OneBotNotSentError);
});

test("需要回执的 OneBot 回复仅记录已确认的消息编号", async () => {
  const { calls, send, frames } = connection();
  const observed: number[] = [];
  const callback = (messageId: number) => { observed.push(messageId); };
  const reply = () => calls.replyWithReceipt(send, { user_id: 42, message: "测试" }, undefined, undefined, callback);
  const confirmed = reply();
  const first = frames.at(-1)!;
  expect(first.action).toBe("send_msg");
  calls.receive({ echo: "不同请求", status: "ok", retcode: 0, data: { message_id: 100 } });
  expect(observed).toEqual([]);
  calls.receive({ echo: first.echo, status: "ok", retcode: 0, data: { message_id: -49 } });
  expect(await confirmed).toBe(true);
  calls.receive({ echo: first.echo, status: "ok", retcode: 0, data: { message_id: -49 } });

  const missing = reply();
  calls.receive({ echo: frames.at(-1)!.echo, status: "ok", retcode: 0, data: {} });
  expect(await missing).toBe(true);
  const rejected = reply();
  calls.receive({ echo: frames.at(-1)!.echo, status: "failed", retcode: 100, data: { message_id: 200 } });
  expect(await rejected).toBe(false);
  const pending = reply();
  calls.close();
  expect(await pending).toBe(false);
  expect(observed).toEqual([-49]);
});

test("OneBot 只有有效的有符号非零消息编号才确认发送", async () => {
  const { calls, send, frames } = connection();
  const delivered: number[] = [];
  const confirm = async (id: unknown) => {
    const result = calls.sendConfirmed(send, { user_id: 42 }, "摘要", undefined, messageId => { delivered.push(messageId); });
    calls.receive({ echo: frames.at(-1)!.echo, status: "ok", retcode: 0, data: { message_id: id } });
    return result;
  };
  for (const id of [undefined, 0, -0, 2_147_483_648, -2_147_483_649, 1.5]) {
    expect(await confirm(id)).toBe("unknown");
  }
  expect(await confirm(-2_147_483_648)).toBe("confirmed");
  expect(await confirm(2_147_483_647)).toBe("confirmed");
  expect(delivered).toEqual([-2_147_483_648, 2_147_483_647]);
});

test("好友申请窗口只显示当前连接观察到且未提交的普通申请", async () => {
  const { calls, send, frames, confirm } = connection();
  const entry = { userId: 42, comment: "原始附言" };
  calls.observeFriendRequest("normal-flag", entry);
  calls.observeFriendRequest("normal-flag", { userId: 43, comment: "重复事件" });
  expect(calls.listObservedFriendRequests()).toEqual({ entries: [entry], complete: false });

  const rejected = calls.reviewFriendRequest(send, "normal-flag", true);
  expect(calls.listObservedFriendRequests().entries).toEqual([]);
  confirm(frames[0]!, "failed", 100);
  expect(await rejected).toBe(false);
  expect(calls.listObservedFriendRequests().entries).toEqual([entry]);

  const first = calls.reviewFriendRequest(send, "normal-flag", true);
  const second = calls.reviewFriendRequest(send, "normal-flag", false);
  confirm(frames[2]!);
  expect(await second).toBe(true);
  confirm(frames[1]!, "failed", 100);
  expect(await first).toBe(false);
  calls.observeFriendRequest("normal-flag", entry);
  expect(calls.listObservedFriendRequests().entries).toEqual([]);
  expect(connection().calls.listObservedFriendRequests()).toEqual({ entries: [], complete: false });
});

test("OneBot 批量仅选择本连接未处理且身份一致的原邀请标识", async () => {
  const { calls, send, frames, confirm } = connection();
  const invite = { groupId: 77, inviterId: 42 };
  calls.observeGroupInvitation("exact", invite);
  calls.observeGroupInvitation("exact", invite);
  calls.observeGroupInvitation("conflicted", invite);
  calls.observeGroupInvitation("conflicted", { ...invite, inviterId: 43 });
  calls.observeFriendRequest("friend-only", { userId: 44 });
  const scope = new AbortController().signal;
  const review = async (flag: string, pending: () => boolean) => {
    expect(flag).toBe("exact");
    expect(pending()).toBe(true);
    const accepted = calls.reviewGroupRequest(send, flag, "invite", false, undefined, scope);
    expect(pending()).toBe(false);
    expect(frames[0]).toMatchObject({ action: "set_group_add_request", params: { flag, sub_type: "invite", approve: false, reason: "" } });
    confirm(frames[0]!);
    return await accepted ? "confirmed" as const : "rejected" as const;
  };
  expect(await calls.reviewObservedOwnerRequests("invite", () => false, scope, review)).toEqual({ status: "unavailable" });
  expect(await calls.reviewObservedOwnerRequests("invite", () => true, scope, review)).toEqual({ status: "processed", entries: [
    { id: invite.groupId, status: "confirmed", resolvedFlag: "exact" },
  ] });
  expect(await calls.reviewObservedOwnerRequests("invite", () => true, scope, review)).toEqual({ status: "not-found" });
  expect(await connection().calls.reviewObservedOwnerRequests("invite", () => true, scope, review)).toEqual({ status: "not-found" });
  expect(frames).toHaveLength(1);
});
