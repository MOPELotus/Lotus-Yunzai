import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAutoQuit } from "../lib/auto-quit.ts";
import type { GroupNotice } from "../lib/messages.ts";

async function policy(config?: string, masterIds: (bot: number) => readonly number[] = () => []) {
  const root = await mkdtemp(join(tmpdir(), "lotus-auto-quit-"));
  try {
    if (config !== undefined) {
      const directory = join(root, "config", "config");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "other.yaml"), config);
    }
    return await readAutoQuit(pathToFileURL(`${root}/`), masterIds);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function joinNotice(fields: Partial<GroupNotice> = {}): GroupNotice {
  return {
    post_type: "notice", notice_type: "group", sub_type: "increase", self_id: 10, user_id: 10, group_id: 20,
    time: 1_700_000_000, isMaster: false, isGroup: true, isPrivate: false,
    inspectAutoQuit: async () => ({ memberIds: [10, 30], botRole: "member" }),
    leaveGroup: async () => true, reply: () => { throw new Error("unexpected group reply"); },
    ...fields,
  };
}

test("仅显式正整数启用自身入群检查，缺少入群时间或能力时跳过", async () => {
  const inspections: number[] = [];
  const event = joinNotice({ inspectAutoQuit: async (limit) => {
    inspections.push(limit);
    return { memberIds: [10, 30], botRole: "admin" };
  } });
  for (const config of [undefined, "autoQuit: 0", "autoQuit: -1", "autoQuit: 2.5", "autoQuit: true"]) {
    expect(await (await policy(config))(event)).toBe(false);
  }
  const handle = await policy('autoQuit: "2"');
  expect(await handle({ ...event, user_id: 11 })).toBe(false);
  expect(await handle({ ...event, sub_type: "decrease" })).toBe(false);
  expect(await handle({ ...event, time: undefined })).toBe(false);
  expect(await handle({ ...event, leaveGroup: undefined })).toBe(false);
  expect(await handle({ ...event, action_sub_type: "approve" })).toBe(true);
  expect(inspections).toEqual([2]);
});

test("群内主人无论是否邀请都豁免，其他机器人的主人不自动豁免", async () => {
  const inspected: number[] = [];
  const handle = await policy('autoQuit: 5\nmasterQQ: ["stdin", "31", 32]', (bot) => {
    inspected.push(bot);
    return bot === 10 ? [33] : [34];
  });
  const inGroup = (id: number, group_id: number) => joinNotice({
    group_id, operator_id: 99, inspectAutoQuit: async () => ({ botRole: "member", memberIds: [10, id] }),
  });
  expect(await handle(inGroup(31, 20))).toBe(false);
  expect(await handle(inGroup(32, 21))).toBe(false);
  expect(await handle(inGroup(33, 22))).toBe(false);
  expect(await handle({ ...inGroup(34, 23), isMaster: true })).toBe(true);
  expect(inspected).toEqual([10, 10]);
});

test("仅接受含机器人自身且无重复的名单，阈值包含边界，机器人为群主时跳过", async () => {
  const handle = await policy("autoQuit: 2");
  const snapshots = [
    undefined,
    { botRole: "owner" as const, memberIds: [10, 30] },
    { botRole: "member" as const, memberIds: [30] },
    { botRole: "member" as const, memberIds: [10, 10] },
    { botRole: "member" as const, memberIds: [10, 30, 31] },
  ];
  for (const [index, snapshot] of snapshots.entries()) {
    expect(await handle(joinNotice({ group_id: 21 + index, inspectAutoQuit: async () => snapshot }))).toBe(false);
  }
  expect(await handle(joinNotice({ group_id: 30, inspectAutoQuit: async () => { throw new Error("query failed"); } }))).toBe(false);
  expect(await handle(joinNotice())).toBe(true);
});

test("在途按机器人和群隔离，未确认仍拒绝重放，真正重新入群可处理", async () => {
  const handle = await policy("autoQuit: 2");
  const leave = Promise.withResolvers<boolean>();
  const started = Promise.withResolvers<void>();
  const event = joinNotice({ leaveGroup: () => { started.resolve(); return leave.promise; } });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = handle(event);
    await started.promise;
    expect(await handle(event)).toBe(false);
    expect(await handle({ ...event, group_id: 21, leaveGroup: async () => true })).toBe(true);
    expect(await handle(joinNotice({ self_id: 11, user_id: 11,
      inspectAutoQuit: async () => ({ memberIds: [11, 30], botRole: "member" }),
    }))).toBe(true);
    leave.reject(new Error("不得记录的协议内容"));
    expect(await first).toBe(false);
    expect(warn.mock.calls).toEqual([["[自动退群] 协议端未确认退群结果。"]]);
    expect(await handle(event)).toBe(false);
    expect(await handle({ ...event, time: event.time! - 1 })).toBe(false);
    expect(await handle({ ...event, time: event.time! + 1, leaveGroup: async () => true })).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("停机前不发新退群动作，已经发出的动作等待协议回执", async () => {
  const handle = await policy("autoQuit: 2");
  const stopInspecting = new AbortController();
  const fetched = Promise.withResolvers<{ memberIds: number[]; botRole: "member" }>();
  let actions = 0;
  const event = joinNotice({ inspectAutoQuit: () => fetched.promise, leaveGroup: async () => { actions++; return true; } });
  const ignored = handle(event, stopInspecting.signal);
  stopInspecting.abort();
  fetched.resolve({ memberIds: [10, 30], botRole: "member" });
  expect(await ignored).toBe(false);
  expect(await handle({ ...event, group_id: 21 }, stopInspecting.signal)).toBe(false);
  expect(actions).toBe(0);

  const stopLeaving = new AbortController();
  const started = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<boolean>();
  const pending = handle(joinNotice({ group_id: 22, leaveGroup: () => { started.resolve(); return receipt.promise; } }), stopLeaving.signal);
  await started.promise;
  stopLeaving.abort();
  receipt.resolve(true);
  expect(await pending).toBe(true);
  expect(await handle(joinNotice({ group_id: 23, leaveGroup: async () => false }))).toBe(false);
});

test("较新的入群事件让旧查询失效，再按本次入群重新判断", async () => {
  const handle = await policy("autoQuit: 2");
  const snapshot = { memberIds: [10, 30], botRole: "member" } as const;
  const fetched = Promise.withResolvers<typeof snapshot>();
  const event = joinNotice({ inspectAutoQuit: () => fetched.promise });
  const old = handle(event);
  const newer = handle({ ...event, time: event.time! + 1, inspectAutoQuit: async () => snapshot });
  fetched.resolve(snapshot);
  expect(await old).toBe(false);
  expect(await newer).toBe(true);
});
