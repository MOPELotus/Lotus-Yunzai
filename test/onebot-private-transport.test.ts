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
