import { expect, test } from "bun:test";
import { createManualGroupLeave, manualGroupLeaveInput, manualGroupLeaveSession, type ManualGroupLeaveSession } from "../lib/manual-group-leave.ts";
import type { MessageEvent } from "../lib/messages.ts";

test("待退群期间同账号同群只允许一个操作，警告后重新核实成员关系", async () => {
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const run = createManualGroupLeave(() => {
    waiting.resolve();
    return release.promise;
  });
  const workflow = new AbortController();
  let groups: readonly { id: number }[] = [{ id: 77 }];
  let submitted = 0;
  const replies: string[] = [];
  const session: ManualGroupLeaveSession = {
    botId: 99, userId: 42, groupId: 77, signal: new AbortController().signal,
    isMaster: () => true,
    groups: async () => groups,
    async leave() { submitted++; return "confirmed"; },
    async reply(text) { replies.push(text); return "confirmed"; },
  };
  const event: MessageEvent = {
    msg: "#退群77", raw_message: "#退群77", message: [], post_type: "message",
    message_type: "group", sub_type: "normal", group_id: 77, self_id: 99, user_id: 42,
    isGroup: true, isPrivate: false, isMaster: true, reply: () => false,
    [manualGroupLeaveSession]: session,
  };
  const active = run(event, "77", () => true, workflow.signal);
  await waiting.promise;
  await run(event, "077", () => true, workflow.signal);
  expect(replies).toEqual(["⚠️ 3秒后退出本群聊", "该群的退群操作正在处理。"]);
  groups = [];
  release.resolve();
  await active;
  expect(submitted).toBe(0);
  expect(replies.at(-1)).toBe("❎ 群聊列表查无此群");
});

test("手动退群识别独立前缀和群号，不占用其他以退群起头的命令", () => {
  expect(manualGroupLeaveInput("#退群")).toBe("");
  expect(manualGroupLeaveInput("#退群 77")).toBe("77");
  expect(manualGroupLeaveInput("#退群77")).toBe("77");
  expect(manualGroupLeaveInput("#退群 无效参数")).toBe("无效参数");
  expect(manualGroupLeaveInput("#退群夹具")).toBeUndefined();
});
