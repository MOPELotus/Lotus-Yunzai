import { expect, test } from "bun:test";
import type { MilkyConfirmation } from "../lib/adapters/milky-api.ts";
import { createMilkyRecallReply } from "../lib/adapters/milky-recall-reply.ts";
import type { MessageEvent } from "../lib/messages.ts";

const self_id = 99;
const owner = 51;
const confirmed = { status: "confirmed", data: {} } as const;

function event(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    post_type: "message", message_type: "group", isGroup: true, isPrivate: false, isMaster: false, boundAccount: false,
    msg: "#撤回", raw_message: "#撤回", message: "#撤回", self_id, user_id: owner, group_id: 77, message_id: 0,
    reply: () => true,
    ...overrides,
  };
}

test("Milky 主人自身命令撤回支持序号零，独立引用只能进入已核实的引用入口", async () => {
  const requests: unknown[] = [];
  const prepare = createMilkyRecallReply(new AbortController().signal, async (action, params) => {
    requests.push({ action, params });
    return confirmed;
  }, (user) => user === owner);
  expect(prepare(event({ user_id: 42, isMaster: true, boundAccount: true }))).toBeUndefined();
  expect(prepare(event({ message_id: undefined, reply_id: 660 }))).toBeUndefined();
  expect(prepare(event({ message_id: -1 }))).toBeUndefined();
  expect(prepare(event({ group_id: 0 }))).toBeUndefined();
  expect(prepare(event({ message_type: "private" }))).toBeUndefined();
  expect(prepare(event({ message_type: "terminal" }))).toBeUndefined();
  expect(requests).toEqual([]);

  expect(await prepare(event({ reply_id: "0" }))?.()).toEqual(["confirmed"]);
  expect(prepare(event({ group_id: 78, reply_id: "17" }))).toBeUndefined();
  const friend = event({ message_type: "private", isGroup: false, isPrivate: true, group_id: undefined });
  expect(prepare({ ...friend, reply_id: "9007199254740992" })).toBeUndefined();
  expect(prepare({ ...friend, reply_id: 17 })).toBeUndefined();
  expect(await prepare(friend)?.()).toEqual(["confirmed"]);
  expect(requests).toEqual([
    { action: "recall_group_message", params: { group_id: 77, message_seq: 0 } },
    { action: "recall_private_message", params: { user_id: owner, message_seq: 0 } },
  ]);
});

test("每条撤回独立核对回执，同一命令重放和撤销权限后不再调用协议", async () => {
  const controller = new AbortController();
  const commandResult = Promise.withResolvers<MilkyConfirmation>();
  const interruptedResult = Promise.withResolvers<MilkyConfirmation>();
  const calls: unknown[] = [];
  let authorized = true;
  const prepare = createMilkyRecallReply(controller.signal, async (_action, { message_seq }) => {
    calls.push(message_seq);
    if (message_seq === 0) return commandResult.promise;
    if (message_seq === 4) return interruptedResult.promise;
    throw new Error("回执中断");
  }, () => authorized);
  const request = event();
  const invoke = prepare(request);
  const replay = prepare(request);
  const pending = invoke?.();
  expect(calls).toEqual([0]);
  expect(await replay?.()).toBeUndefined();
  commandResult.resolve({ status: "rejected" });
  expect(await pending).toEqual(["rejected"]);
  expect(await prepare(request)?.()).toBeUndefined();
  const uncertain = event({ message_id: 7 });
  expect(await prepare(uncertain)?.()).toEqual(["unknown"]);
  expect(await prepare(uncertain)?.()).toBeUndefined();

  const revoked = prepare(event({ message_id: 1 }));
  authorized = false;
  expect(await revoked?.()).toBeUndefined();
  authorized = true;
  const disconnected = prepare(event({ message_id: 2 }));
  const interrupted = prepare(event({ message_id: 4 }))?.();
  controller.abort();
  interruptedResult.resolve({ status: "unknown" });
  expect(await interrupted).toBeUndefined();
  expect(await disconnected?.()).toBeUndefined();
  expect(prepare(event({ message_id: 3 }))).toBeUndefined();
  expect(calls).toEqual([0, 7, 4]);
});
