import { expect, test } from "bun:test";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";
import { createUpdateLogCommand, isUpdateLogCommand } from "../lib/update-log-command.ts";

type ReadLog = Parameters<typeof createUpdateLogCommand>[0];

function fixture(read: ReadLog = async (requested) => ({ name: requested ?? "Lotus-Yunzai", lines: ["最新", "较旧"] })) {
  const queries: (string | undefined)[] = [];
  const replies: MessageReply[] = [];
  const handler = createUpdateLogCommand(async (requested) => {
    queries.push(requested);
    return read(requested);
  });
  return {
    queries, replies,
    dispatch(msg: string, event: Partial<MessageEvent> = {}) {
      return handler({
        msg, message: msg, raw_message: msg, post_type: "message", message_type: "group",
        isGroup: true, isPrivate: false, isMaster: false,
        reply: (reply) => { replies.push(reply); return true; },
        ...event,
      });
    },
  };
}

test("普通成员可查宿主、紧连插件名、中文目录名及 scoped 包名", async () => {
  const { queries, replies, dispatch } = fixture();
  expect(isUpdateLogCommand("#更新日志")).toBe(true);
  expect(isUpdateLogCommand(" #更新日志图鉴插件")).toBe(true);
  expect(isUpdateLogCommand("#更新")).toBe(false);
  expect(isUpdateLogCommand("请发#更新日志")).toBe(false);
  expect(await dispatch("#更新")).toBe(false);

  expect(await dispatch("#更新日志")).toBe(true);
  await dispatch("#更新日志system");
  await dispatch("#更新日志  图鉴插件-2.0  ");
  await dispatch("#更新日志 @lotus-yunzai/system");
  expect(queries).toEqual([undefined, "system", "图鉴插件-2.0", "@lotus-yunzai/system"]);
  expect(replies[0]).toBe("Lotus-Yunzai 更新日志，共2条\n\n最新\n\n较旧");
});

test("路径、控制字符及无效包名不交给日志读取器", async () => {
  const { queries, replies, dispatch } = fixture();
  const invalid = ["../system", "scope/system", "/system", "@scope/../system", "@scope/", "a\\b",
    "a b", "system\x00", "system\n", "@scope/name/", "%2fetc", "a".repeat(215)];
  for (const target of invalid) expect(await dispatch(`#更新日志 ${target}`)).toBe(true);
  expect(queries).toEqual([]);
  expect(replies).toHaveLength(invalid.length);
  expect(replies.every((message) => typeof message === "string" && message.includes("请输入有效的插件名"))).toBe(true);
});

test("合并转发沿用旧标题及双换行正文，提示日志采用宿主锁定版本", async () => {
  const { replies, dispatch } = fixture(async () => ({
    name: "系统插件", lines: ["[11-19] 最新", "[11-18] 较旧"], pinnedMismatch: true,
  }));
  const forwarded: (readonly MessageReply[])[] = [];
  await dispatch("#更新日志system", { forward: async (nodes) => { forwarded.push(nodes); return true; } });
  expect(forwarded).toEqual([[
    "系统插件 更新日志，共2条\n当前检出的插件版本与宿主锁定版本不同，以下日志按宿主锁定版本列出。",
    "[11-19] 最新\n\n[11-18] 较旧",
  ]]);
  expect(replies).toEqual([]);
});

test("明确拒绝转发降级为一条限长文本，未确认仅提示核对", async () => {
  const { replies, dispatch } = fixture(async () => ({ name: "系统插件", lines: ["中".repeat(2_000), "较旧"] }));
  await dispatch("#更新日志system", { forward: async () => false });
  await dispatch("#更新日志system", { forward: async () => { throw new Error("protocol details"); } });
  expect(replies).toHaveLength(2);
  expect(Buffer.byteLength(replies[0] as string)).toBeLessThanOrEqual(3000);
  expect(replies[0]).toStartWith("系统插件 更新日志，共2条\n\n中");
  expect(replies[0]).toEndWith("日志内容过长，已截取部分内容。");
  expect(replies[1]).toBe("更新日志转发结果未确认，请在聊天中核对。");
});

test("不可查、读取失败或无提交时回复简洁文本", async () => {
  const missing = fixture(async () => undefined);
  const empty = fixture(async () => ({ name: "系统插件", lines: [] }));
  const failed = fixture(async () => { throw new Error("private backend details"); });
  let forwards = 0;
  const forward = async () => { forwards++; return true; };
  for (const { dispatch } of [missing, empty, failed]) await dispatch("#更新日志system", { forward });
  expect(forwards).toBe(0);
  expect(missing.replies).toEqual(["暂无可用的更新日志。"]);
  expect(empty.replies).toEqual(["系统插件 更新日志，共0条"]);
  expect(failed.replies).toEqual(["读取更新日志失败，请稍后重试。"]);
});
