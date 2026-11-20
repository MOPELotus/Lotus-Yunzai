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

test.each([
  { label: "新部署未配置", enabled: false },
  { label: "只有主配置中的其他字段", primary: 'master: ["99:51"]\n', enabled: false },
  { label: "已存在的空旧配置", legacy: "# 使用旧版默认\n", enabled: true },
  { label: "主配置只有其他字段时旧默认仍生效", primary: "disablePrivate: true\n", legacy: 'master: ["99:51"]\n', enabled: true },
  { label: "继承旧配置的数字字符串", legacy: "autoFriend: '1'\n", enabled: true },
  { label: "使用旧配置中明确的 true", legacy: "autoFriend: true\n", enabled: true },
  { label: "主配置只有其他字段时旧关闭仍生效", primary: "disablePrivate: true\n", legacy: "autoFriend: 0\n", enabled: false },
  { label: "主配置明确关闭可覆盖旧默认", primary: "autoFriend: 0\n", legacy: "{}\n", enabled: false },
  { label: "主配置明确开启可覆盖旧关闭", primary: "autoFriend: 1\n", legacy: "autoFriend: 0\n", enabled: true },
  { label: "主配置明确空值维持关闭", primary: "autoFriend:\n", legacy: "{}\n", enabled: false },
  { label: "旧文件格式无效时保留有效主配置", primary: "disablePrivate: true\n", legacy: "[]\n", enabled: false },
])("好友自动通过沿用当前和旧运行配置 $label", ({ primary, legacy, enabled }) => usingRoot(async (path, root) => {
  if (legacy !== undefined) await writeFile(join(path, "config/config/other.yaml"), legacy);
  if (primary !== undefined) await writeFile(join(path, "config/other.yaml"), primary);
  const handle = await readFriendRequests(root, 0);
  const result = await handle(request(async (approve) => approve === true));
  expect(result).toBe(enabled ? "confirmed" : undefined);
}));

test("继承旧好友策略时保留旧黑白名单和显式主覆盖", () => usingRoot(async (path, root) => {
  const legacy = join(path, "config/config/other.yaml");
  const primary = join(path, "config/other.yaml");
  await writeFile(legacy, 'whiteUser: [42, 43]\nblackUser: ["42"]\n');
  await writeFile(primary, "disablePrivate: true\n");
  const requestFor = (user_id: number) => request(async () => true, { user_id, flag: String(user_id), isMaster: true });
  const inherited = await readFriendRequests(root, 0);
  expect(await inherited(requestFor(41))).toBeUndefined();
  expect(await inherited(requestFor(42))).toBeUndefined();
  expect(await inherited(requestFor(43))).toBe("confirmed");
  await writeFile(primary, "blackUser: []\n");
  expect(await (await readFriendRequests(root, 0))(requestFor(42))).toBe("confirmed");
  await writeFile(legacy, "{}\n");
  await writeFile(primary, "disablePrivate: true\n");
  expect(await (await readFriendRequests(root, 0))(requestFor(528_952_540))).toBeUndefined();
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

test("已确认申请记录轮转后仍保留未确认申请", () => usingRoot(async (path, root) => {
  await writeFile(join(path, "config/config/other.yaml"), "{}\n");
  const handle = await readFriendRequests(root, 0);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const unknown = request(async () => { throw new Error(); });
  try {
    expect(await handle(unknown)).toBe("unknown");
    await Promise.all(Array.from({ length: 4_095 }, (_, id) => handle(request(async () => true, { flag: String(id) }))));
    expect(await handle(request(async () => true, { flag: "last-retained-confirmation" }))).toBe("confirmed");
    expect(await handle(request(async () => true, { flag: "confirm-after-rotation" }))).toBe("confirmed");
    expect(await handle(unknown)).toBe("duplicate");
    expect(warn.mock.calls).toHaveLength(1);
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
