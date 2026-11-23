import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readRequestOtherPolicies } from "../lib/request-other-policies.ts";
import { readAutoQuit } from "../lib/auto-quit.ts";
import { readGroupInvitations } from "../lib/group-invitations.ts";
import { readFriendRequests } from "../lib/friend-requests.ts";
import type { FriendRequest, GroupNotice, GroupRequest } from "../lib/messages.ts";

async function fixture(run: (root: URL, file: string, signal: AbortSignal) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "lotus-other-hot-"));
  const lifecycle = new AbortController();
  try {
    await mkdir(join(path, "config/config"), { recursive: true });
    await run(pathToFileURL(path + "/"), join(path, "config/config/other.yaml"), lifecycle.signal);
  } finally {
    lifecycle.abort();
    await rm(path, { recursive: true, force: true });
  }
}

test("待自动接受的好友发送前按新配置复查，拒绝期间保留已审批去重", () => fixture(async (root, file, signal) => {
  await writeFile(file, "autoFriend: 1\n");
  const policy = await readRequestOtherPolicies(root, signal);
  const handle = await readFriendRequests(root, 35, policy);
  let approvals = 0;
  const event: FriendRequest = {
    post_type: "request", request_type: "friend", sub_type: "add", self_id: 10, user_id: 31, flag: "previous",
    isGroup: false, isPrivate: true, isMaster: false, notifyMasters: async () => 0, reply: () => false,
    async approve() { approvals++; return true; },
  };
  expect(await handle(event)).toBe("confirmed");
  const pending = handle({ ...event, flag: "waiting" });
  await writeFile(file, "autoFriend: 0\n");
  expect(await pending).toBeUndefined();
  expect(approvals).toBe(1);

  await writeFile(file, "autoFriend: 1\n");
  await policy.refresh();
  expect(await handle(event)).toBe("duplicate");
  let enabledInHost = true;
  const pendingInHost = handle({ ...event, flag: "routing-changed" }, undefined, () => enabledInHost);
  enabledInHost = false;
  expect(await pendingInHost).toBeUndefined();
  expect(approvals).toBe(1);
}));

test("邀请用热更新名单，文件损坏保留上次有效设置，关闭监听时保留启动策略", () => fixture(async (root, file, signal) => {
  await writeFile(file, "autoGroup: 0\nblackUser: [31]\n");
  const startup = await readRequestOtherPolicies(root);
  const watching = await readRequestOtherPolicies(root, signal);
  const fixed = await readGroupInvitations(root, startup);
  const active = await readGroupInvitations(root, watching);
  const request: GroupRequest = {
    post_type: "request", request_type: "group", sub_type: "invite", self_id: 10, user_id: 31, group_id: 20,
    flag: "fixture", isGroup: true, isPrivate: false, isMaster: false, approve: async () => true,
    notifyMasters: async () => 0, reply: () => false,
  };
  expect(active.admits(request)).toBe(false);
  await writeFile(file, "autoGroup: 1\nblackUser: []\n");
  await watching.refresh();
  expect(active.admits(request)).toBe(true);
  expect(await active.review(request)).toBe("confirmed");
  expect(await fixed.review(request)).toBe("skip");
  await writeFile(file, "autoGroup: [\n");
  await watching.refresh();
  expect(await active.review({ ...request, flag: "another" })).toBe("confirmed");
  await writeFile(file, "autoGroup: 0\n");
  await watching.refresh();
  expect(await active.review({ ...request, flag: "closed" })).toBe("skip");
}));

test("自动退群在查询中改变阈值或主人时需要最新完整的成员证据", () => fixture(async (root, file, signal) => {
  await writeFile(file, "autoQuit: 2\n");
  const source = await readRequestOtherPolicies(root, signal);
  const handle = await readAutoQuit(root, () => [], () => [], source);
  const inspections: number[] = [];
  let leaves = 0;
  const start = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const event: GroupNotice = {
    post_type: "notice", notice_type: "group", sub_type: "increase", self_id: 10, user_id: 10, group_id: 20,
    time: 1_700_000_000, isMaster: false, isGroup: true, isPrivate: false, reply: () => false,
    async inspectAutoQuit(threshold) {
      inspections.push(threshold);
      if (inspections.length === 1) { start.resolve(); await finish.promise; return; }
      return { memberIds: [10, 31, 32], botRole: "member" };
    },
    async leaveGroup() { leaves++; return true; },
  };
  const pending = handle(event);
  await start.promise;
  await writeFile(file, 'autoQuit: 3\nmaster: ["10:31"]\n');
  finish.resolve();
  expect(await pending).toBe(false);
  expect(inspections).toEqual([2, 3]);
  expect(leaves).toBe(0);
  await writeFile(file, "autoQuit: 3\n");
  await source.refresh();
  expect(await handle({ ...event, time: event.time! + 1 })).toBe(true);
  expect(leaves).toBe(1);

  const warned = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<boolean>();
  const waitingForNotice = handle({
    ...event,
    time: event.time! + 2,
    reply() { warned.resolve(); return receipt.promise; },
  });
  await warned.promise;
  await writeFile(file, 'autoQuit: 3\nmaster: ["10:31"]\n');
  receipt.resolve(true);
  expect(await waitingForNotice).toBe(false);
  expect(leaves).toBe(1);
}));
