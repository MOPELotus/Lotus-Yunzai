import { expect, test } from "bun:test";
import { createLogCommand, isLogCommand } from "../lib/log-command.ts";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";

type ReadLogs = Parameters<typeof createLogCommand>[0];

function fixture(read: ReadLogs = async () => ["newest", "oldest"]) {
  const queries: Parameters<ReadLogs>[] = [];
  const replies: MessageReply[] = [];
  const handler = createLogCommand(async (...args) => {
    queries.push(args);
    return read(...args);
  });
  function dispatch(msg: string, event: Partial<MessageEvent> = {}) {
    return handler({
      msg, message: msg, raw_message: msg, post_type: "message", message_type: "private",
      isGroup: false, isPrivate: true, isMaster: true, boundAccount: true, self_id: 99, user_id: 42,
      reply: (reply) => { replies.push(reply); return true; },
      ...event,
    });
  }
  return { dispatch, queries, replies };
}

test("日志别名、紧连或分隔条数与字面关键词", async () => {
  const { dispatch, queries, replies } = fixture();
  expect(isLogCommand(" #日志12 ")).toBe(true);
  expect(isLogCommand("#运行日志 15")).toBe(true);
  expect(isLogCommand("#错误日志")).toBe(true);
  expect(isLogCommand("#更新日志")).toBe(false);
  expect(await dispatch("请发#日志")).toBe(false);

  await dispatch("#日志");
  await dispatch("#运行日志12");
  await dispatch("#错误日志 99999999999999999999999 错误[502].* #日志");
  await dispatch("#运行日志错误 502");
  await dispatch("#日志 404https");
  await dispatch("#日志0");
  expect(queries).toEqual([
    ["runtime", { limit: 100 }],
    ["runtime", { limit: 12 }],
    ["error", { limit: 1000, search: "错误[502].* #日志" }],
    ["runtime", { limit: 1000, search: "错误 502" }],
    ["runtime", { limit: 1000, search: "404https" }],
  ]);
  expect(replies.at(-1)).toBe("日志条数须大于 0，最多显示 1000 条。");
});

test("日志仅由当前已绑定机器人的主人私聊或授权终端读取", async () => {
  const { dispatch, queries, replies } = fixture();
  expect(await dispatch("#日志", { message_type: "group", isGroup: true, isPrivate: false })).toBe(true);
  expect(await dispatch("#日志", { isMaster: false })).toBe(true);
  expect(await dispatch("#错误日志", { boundAccount: false })).toBe(true);
  expect(await dispatch("#运行日志", { boundAccount: undefined })).toBe(true);
  expect(await dispatch("#日志", { message_type: "terminal", isMaster: false })).toBe(true);
  expect(queries).toEqual([]);
  expect(replies).toEqual([]);

  await dispatch("#运行日志", {
    message_type: "terminal", isPrivate: false, boundAccount: undefined,
    forward: async () => { throw new Error("终端不能调用转发"); },
  });
  expect(queries).toEqual([["runtime", { limit: 100 }]]);
  expect(replies).toEqual(["最近 2 条运行日志\nnewest\noldest"]);
});

test("Milky 日志只认当前账号的私聊主人权限", async () => {
  const { dispatch, queries, replies } = fixture();
  const milky = { adapter: "milky", isMaster: false, boundAccount: false, canManageProcess: true } as const;
  await dispatch("#日志", { ...milky, message_type: "group", group_id: 77, isGroup: true, isPrivate: false });
  await dispatch("#日志", { ...milky, self_id: 0 });
  await dispatch("#日志", { ...milky, user_id: undefined });
  await dispatch("#日志", { ...milky, canManageProcess: false, isMaster: true, boundAccount: true });
  expect(queries).toEqual([]);
  expect(replies).toEqual([]);

  await dispatch("#错误日志 1 newer", milky);
  expect(queries).toEqual([["error", { limit: 1, search: "newer" }]]);
  expect(replies[0]).toMatch(/^最近 1 条错误日志\nnewest/u);
});

test("合并转发保序按行分节点，超长行按完整字符切分，确认后不重复回复", async () => {
  const first = `first${"中".repeat(250)}`;
  const second = `second${"文".repeat(250)}`;
  const long = "🙂".repeat(700);
  const { dispatch, replies } = fixture(async () => [first, second, long, "last"]);
  const sent: (readonly MessageReply[])[] = [];
  await dispatch("#日志", { forward: async (nodes) => { sent.push(nodes); return true; } });
  expect(sent).toEqual([[
    "最近 4 条运行日志", first, second, "🙂".repeat(300), "🙂".repeat(300), `${"🙂".repeat(100)}\nlast`,
  ]]);
  expect(replies).toEqual([]);
});

test("大量日志只转发有界节点，并标明省略正文", async () => {
  const lines = Array.from({ length: 1_000 }, (_, index) => `${index}:${"x".repeat(650)}`);
  const { dispatch, replies } = fixture(async () => lines);
  const sent: (readonly MessageReply[])[] = [];
  await dispatch("#日志1000", { forward: async (nodes) => { sent.push(nodes); return true; } });

  expect(sent).toHaveLength(1);
  const nodes = sent[0]!;
  expect(nodes).toHaveLength(100);
  expect(nodes.slice(1, -1)).toEqual(lines.slice(0, 98));
  expect(nodes.at(-1)).toBe("日志内容过长，已截取部分内容。");
  expect(replies).toEqual([]);
});

test("明确拒绝转发仅降级为一条限长文本，未确认转发只提示核对", async () => {
  const line = `newest ${"🙂".repeat(1000)}`;
  const { dispatch, replies } = fixture(async () => [line, "oldest"]);
  await dispatch("#错误日志", { forward: async () => false });
  await dispatch("#错误日志", { forward: async () => { throw new Error("backend-only details"); } });

  expect(replies).toHaveLength(2);
  expect(replies[0]).toBeTypeOf("string");
  expect(Buffer.byteLength(replies[0] as string)).toBeLessThanOrEqual(3000);
  expect(replies[0]).toStartWith("最近 2 条错误日志\nnewest");
  expect(replies[0]).toEndWith("日志内容过长，已截取部分内容。");
  expect(replies[0]).not.toContain("�");
  expect(replies[1]).toBe("日志转发结果未确认，请在聊天中核对。");
});

test("没有结果或读取失败时回复通用提示，不尝试转发", async () => {
  const empty = fixture(async () => []);
  const failed = fixture(async () => { throw new Error("private backend details"); });
  let forwards = 0;
  const forward = async () => { forwards++; return true; };
  await empty.dispatch("#日志 10 [secret]", { forward });
  await failed.dispatch("#错误日志", { forward });
  expect(empty.replies).toEqual(["暂无相关运行日志。"]);
  expect(failed.replies).toEqual(["读取日志失败，请稍后重试。"]);
  expect(forwards).toBe(0);
});
