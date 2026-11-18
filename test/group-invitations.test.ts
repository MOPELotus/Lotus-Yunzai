import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OneBotNotSentError } from "../lib/adapters/onebot-calls.ts";
import { readGroupInvitations } from "../lib/group-invitations.ts";
import type { GroupRequest } from "../lib/messages.ts";

async function policy(config?: string, legacy = false) {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-invitations-"));
  try {
    if (config !== undefined) {
      const directory = join(path, legacy ? "config/config" : "config");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "other.yaml"), config);
    }
    return await readGroupInvitations(pathToFileURL(`${path}/`));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

function invitation(overrides: Partial<GroupRequest> = {}): GroupRequest {
  return {
    post_type: "request", request_type: "group", sub_type: "invite", self_id: 10, user_id: 20, group_id: 30,
    flag: "opaque invite flag", isGroup: true, isPrivate: false, isMaster: false,
    approve: async () => true, notifyMasters: async () => 0, reply: () => true,
    ...overrides,
  };
}

test("只有显式 autoGroup 开启旧邀请策略，0 仅当前 Bot 主人，1 所有人，入群申请始终手审", async () => {
  const calls: (boolean | undefined)[] = [];
  const owner = invitation({ isMaster: true, approve: async (allow) => { calls.push(allow); return true; } });
  const nonOwner = { ...owner, isMaster: false };
  expect(await (await policy())(owner)).toBe("skip");
  expect(await (await policy("autoGroup: false"))(owner)).toBe("skip");
  const masters = await policy("autoGroup: 0", true);
  expect(await masters(nonOwner)).toBe("skip");
  expect(await masters(owner)).toBe("confirmed");
  expect(await masters(nonOwner)).toBe("duplicate");
  const everyone = await policy('autoGroup: "1"');
  expect(await everyone({ ...nonOwner, sub_type: "add" })).toBe("skip");
  expect(await everyone({ ...nonOwner, user_id: nonOwner.self_id })).toBe("skip");
  expect(await everyone(nonOwner)).toBe("confirmed");
  expect(calls).toEqual([true, true]);
});

test("按机器人及群隔离邀请，审核在途和已确认事件只提交一次", async () => {
  const handle = await policy("autoGroup: 1");
  const answer = Promise.withResolvers<boolean>();
  let calls = 0;
  const event = invitation({ approve: () => { calls++; return answer.promise; } });
  const first = handle(event);
  expect(await handle({ ...event, user_id: 21 })).toBe("duplicate");
  expect(calls).toBe(1);
  answer.resolve(true);
  expect(await first).toBe("confirmed");
  expect(await handle(event)).toBe("duplicate");
  expect(await handle({ ...event, self_id: 11 })).toBe("confirmed");
  expect(await handle({ ...event, group_id: 31 })).toBe("confirmed");
  expect(await handle({ ...event, flag: `${event.flag} ` })).toBe("confirmed");
  expect(calls).toBe(4);
});

test("明确失败允许手审，未确认结果拦截后续重复事件", async () => {
  const handle = await policy("autoGroup: 1");
  const rejected = invitation({ approve: async () => false });
  const notSent = invitation({ flag: "not-sent", approve: async () => { throw new OneBotNotSentError(); } });
  let calls = 0;
  const unknown = invitation({ flag: "unknown", approve: async () => { calls++; throw new Error("连接断开"); } });
  expect(await handle(rejected)).toBe("rejected");
  expect(await handle(rejected)).toBe("duplicate");
  expect(await handle(notSent)).toBe("rejected");
  expect(await handle(unknown)).toBe("unknown");
  expect(await handle(unknown)).toBe("duplicate");
  expect(calls).toBe(1);
});

test("预先退出不尝试审批，已发出的动作继续确认", async () => {
  const handle = await policy("autoGroup: 1");
  const stopping = new AbortController();
  const answer = Promise.withResolvers<boolean>();
  const event = invitation({ approve: () => answer.promise });
  const result = handle(event, stopping.signal);
  stopping.abort();
  const later = invitation({ flag: "later", approve: async () => { throw new Error("unexpected action"); } });
  expect(await handle(later, stopping.signal)).toBe("skip");
  expect(await handle(event, stopping.signal)).toBe("duplicate");
  answer.resolve(true);
  expect(await result).toBe("confirmed");
  expect(await handle(invitation({ flag: later.flag }))).toBe("confirmed");
});

test("已确认记录轮转后仍可审批新邀请，旧的未知结果不重复提交", async () => {
  const handle = await policy("autoGroup: 1");
  const unknown = invitation({ approve: async () => { throw new Error("未确认"); } });
  expect(await handle(unknown)).toBe("unknown");
  for (let index = 0; index < 4097; index++) {
    const result = await handle(invitation({ flag: `invitation-${index}` }));
    if (result !== "confirmed") throw new Error(`第 ${index} 条邀请未确认`);
  }
  expect(await handle(invitation({ flag: "another invitation" }))).toBe("confirmed");
  expect(await handle(unknown)).toBe("duplicate");
});
