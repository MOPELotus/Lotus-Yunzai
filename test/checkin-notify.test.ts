import { expect, test } from "bun:test";
import { notifyCheckin, type CheckinNotifyTransport } from "../lib/checkin-notify.ts";
import { segment } from "../lib/messages.ts";

const userId = 901;
const settings = { enabled: true, prefer: "private", fallbackGroups: [501, 502] } as const;
const reply = [segment.image(new Uint8Array([1, 2, 3])), "签到结果"] as const;

function transport(overrides: Partial<CheckinNotifyTransport> = {}): CheckinNotifyTransport {
  return {
    async isFriend() { throw new Error("未预期检查好友"); },
    async sendPrivate() { throw new Error("未预期发送私聊"); },
    async isGroupMember() { throw new Error("未预期检查群成员"); },
    async sendGroup() { throw new Error("未预期发送群聊"); },
    ...overrides,
  };
}

test("关闭通知或失效对象完全跳过发送端", async () => {
  const transports = [new Proxy(transport(), { get() { throw new Error("未启用时不应读取发送端"); } })];
  expect(await notifyCheckin({ userId, settings: { ...settings, enabled: false }, reply, transports }))
    .toEqual({ status: "skipped" });
  expect(await notifyCheckin({ userId, settings, reply, transports, signal: AbortSignal.abort() }))
    .toEqual({ status: "skipped" });
  expect(await notifyCheckin({ userId: -1, settings, reply, transports })).toEqual({ status: "unavailable" });
});

test("默认先由已确认好友的在线端发送原私聊回复", async () => {
  const trace: string[] = [];
  const transports = [
    transport({
      async isFriend(id) { trace.push(`好友甲 ${id}`); return false; },
      async sendPrivate() { trace.push("不应发送甲"); return "confirmed"; },
    }),
    transport({
      async isFriend(id) { trace.push(`好友乙 ${id}`); return true; },
      async sendPrivate(id, original) {
        trace.push(`私聊乙 ${id}`);
        expect(original).toBe(reply);
        return "confirmed";
      },
      async isGroupMember() { trace.push("不应查群"); return true; },
    }),
  ];
  expect(await notifyCheckin({ userId, settings, reply, transports })).toEqual({ status: "confirmed", channel: "private" });
  expect(trace).toEqual(["好友甲 901", "好友乙 901", "私聊乙 901"]);
});

test("群偏好仅依序检查去重后的显式群，同一发送端核对当前用户后附 @", async () => {
  const trace: string[] = [];
  const transports = [
    transport({
      async isFriend() { trace.push("禁止私聊"); return true; },
      async isGroupMember(group, user) { trace.push(`成员甲 ${group} ${user}`); return false; },
      async sendGroup() { trace.push("成员未确认仍发送"); return "confirmed"; },
    }),
    transport({
      async isGroupMember(group, user) {
        trace.push(`成员乙 ${group} ${user}`);
        if (group === 501) throw new Error("名单不可用");
        return true;
      },
      async sendGroup(group, payload) {
        trace.push(`群聊乙 ${group}`);
        expect(payload).toEqual([segment.at(userId), "\n", ...reply]);
        return "confirmed";
      },
    }),
  ];
  expect(await notifyCheckin({
    userId, settings: { ...settings, prefer: "group", fallbackGroups: [0, 501, 501, 2 ** 53, 502] }, reply, transports,
  })).toEqual({ status: "confirmed", channel: "group", groupId: 502 });
  expect(trace).toEqual(["成员甲 501 901", "成员乙 501 901", "成员甲 502 901", "成员乙 502 901", "群聊乙 502"]);
});

test("明确拒绝后可回落，发送未知时不再尝试同群其他端或下一群", async () => {
  const trace: string[] = [];
  const first = transport({
    async isFriend() { return true; },
    async sendPrivate() { trace.push("私聊"); return "rejected"; },
    async isGroupMember() { return true; },
    async sendGroup(id) { trace.push(`群甲 ${id}`); return "rejected"; },
  });
  const second = transport({
    async isFriend() { return false; },
    async isGroupMember() { return true; },
    async sendGroup(id) { trace.push(`群乙 ${id}`); return "unknown"; },
  });
  expect(await notifyCheckin({ userId, settings, reply, transports: [first, second] }))
    .toEqual({ status: "unknown", channel: "group", groupId: 501 });
  expect(trace).toEqual(["私聊", "群甲 501", "群乙 501"]);

  const interrupted = transport({
    async isFriend() { return true; },
    async sendPrivate() { trace.push("私聊连接中断"); throw new Error("应视为未知"); },
  });
  expect(await notifyCheckin({ userId, settings, reply, transports: [interrupted, first] }))
    .toEqual({ status: "unknown", channel: "private" });
  expect(trace).toEqual(["私聊", "群甲 501", "群乙 501", "私聊连接中断"]);
});

test("核实成员后若任务已取消，不发送回执", async () => {
  const controller = new AbortController();
  const trace: string[] = [];
  const transports = [transport({
    async isGroupMember(id) { trace.push(`成员 ${id}`); controller.abort(); return true; },
    async sendGroup() { trace.push("不应发送"); return "confirmed"; },
  })];
  expect(await notifyCheckin({ userId, settings: { ...settings, prefer: "group" }, reply, transports, signal: controller.signal }))
    .toEqual({ status: "skipped" });
  expect(trace).toEqual(["成员 501"]);
  expect(await notifyCheckin({ userId, settings: { ...settings, prefer: "group", fallbackGroups: [] }, reply, transports }))
    .toEqual({ status: "unavailable" });
});
