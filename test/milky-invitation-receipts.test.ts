import { expect, test } from "bun:test";
import { createMilkyInvitationReceipts, milkyInvitationNoticeHash } from "../lib/adapters/milky-invitation-receipts.ts";

test("原群邀请通知按机器人、主人和发送回执隔离，跨进程保留原序号", async () => {
  const values = new Map<string, string>();
  const store = {
    async read(key: string) { return values.get(key) ?? null; },
    async write(key: string, value: string, ttl: number) {
      expect(ttl).toBe(3_660);
      values.set(key, value);
    },
  };
  const scope = { account: 100, owner: 51, message: 8 };
  const original = { groupId: 90, inviterId: 42, sequence: 1_528 };
  const now = 1_700_000_000_000;
  const notice = "一条实际送达的邀请通知";
  const first = createMilkyInvitationReceipts(() => store, () => now);
  await first.record(scope, original, notice);
  await first.record({ ...scope, owner: scope.account }, original, notice);
  await first.record({ ...scope, message: -1 }, original, notice);
  await first.record({ ...scope, message: 9 }, { ...original, inviterId: scope.account }, notice);
  expect(values.size).toBe(1);

  const restarted = createMilkyInvitationReceipts(() => store);
  expect(await restarted.read(scope)).toEqual({ expires: now + 3_600_000, origin: original, noticeHash: milkyInvitationNoticeHash(notice) });
  expect([...values.values()][0]).not.toContain(notice);
  expect(await restarted.read({ ...scope, owner: 52 })).toBeUndefined();
  expect(await restarted.read({ ...scope, account: 101 })).toBeUndefined();
  expect(await restarted.read({ ...scope, message: 9 })).toBeUndefined();
  values.set("receipt:milky:100:51:8", '{"expires":1700003600000,"origin":{"groupId":90,"inviterId":42,"sequence":"1528"}}');
  expect(await restarted.read(scope)).toBeUndefined();
});
