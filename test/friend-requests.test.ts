import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFriendRequests } from "../lib/friend-requests.ts";
import type { FriendRequest } from "../lib/messages.ts";

function request(approve: FriendRequest["approve"], fields: Partial<FriendRequest> = {}): FriendRequest {
  return {
    post_type: "request",
    request_type: "friend",
    sub_type: "add",
    self_id: 10001,
    user_id: 10002,
    flag: "fixture-flag",
    isGroup: false,
    isPrivate: true,
    isMaster: false,
    approve,
    notifyMasters: async () => 0,
    reply: () => false,
    ...fields,
  };
}

async function usingRoot(run: (path: string, root: URL) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "lotus-yunzai-friend-"));
  try {
    await mkdir(join(path, "config/config"), { recursive: true });
    await run(path, pathToFileURL(`${path}/`));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

test("好友申请仅在旧配置显式启用时自动同意", () => usingRoot(async (path, root) => {
  let approved = 0;
  const event = request(async (approve) => {
    expect(approve).toBe(true);
    approved++;
    return true;
  });

  await (await readFriendRequests(root, 0))(event);
  expect(approved).toBe(0);

  await writeFile(join(path, "config/config/other.yaml"), "autoFriend: '1'\n");
  await (await readFriendRequests(root, 0))(event);
  expect(approved).toBe(1);

  await writeFile(join(path, "config/other.yaml"), "autoFriend: 0\n");
  await (await readFriendRequests(root, 0))(event);
  expect(approved).toBe(1);
}));

test("好友申请按机器人和 flag 去重，不因不明回执重试或输出 flag", () => usingRoot(async (path, root) => {
  await writeFile(join(path, "config/other.yaml"), "autoFriend: 1\n");
  const handle = await readFriendRequests(root, 0);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let attempted = 0;
  const unknown = request(async () => {
    attempted++;
    throw new Error("fixture-flag");
  });
  const rejected = request(async () => {
    attempted++;
    return false;
  }, { self_id: 10003 });

  try {
    await Promise.all([handle(unknown), handle(unknown), handle(rejected)]);
    await handle(unknown);
    await handle(rejected);
    expect(attempted).toBe(2);
    expect(warn.mock.calls).toHaveLength(2);
    expect(warn.mock.calls).toEqual(expect.arrayContaining([
      ["[好友申请] 协议端未接受自动审批。"],
      ["[好友申请] 未确认自动审批结果。"],
    ]));
  } finally {
    warn.mockRestore();
  }
}));

test("停机取消等待中的好友申请，保留已发送动作的回执等待", () => usingRoot(async (path, root) => {
  await writeFile(join(path, "config/other.yaml"), "autoFriend: 1\n");
  const waiting = await readFriendRequests(root);
  const stopWaiting = new AbortController();
  let attempted = 0;
  const event = request(async () => {
    attempted++;
    return true;
  });
  const pending = waiting(event, stopWaiting.signal);
  stopWaiting.abort();
  await pending;
  expect(attempted).toBe(0);

  const handle = await readFriendRequests(root, 0);
  const sent = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<boolean>();
  const stopAfterSend = new AbortController();
  let finished = false;
  const inFlight = handle(request(async () => {
    sent.resolve();
    return receipt.promise;
  }), stopAfterSend.signal).then(() => { finished = true; });
  await sent.promise;
  stopAfterSend.abort();
  await Promise.resolve();
  expect(finished).toBe(false);
  receipt.resolve(true);
  await inFlight;
  expect(finished).toBe(true);
}));
