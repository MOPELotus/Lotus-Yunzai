import { expect, test } from "bun:test";
import { confirmJoinReview, createGroupJoinReview, type JoinNoticeQuote, type JoinRequestOrigin } from "../lib/group-join-review.ts";

const origin = { adapter: "onebot", botId: 101, groupId: 201, userId: 301, flag: "401" } as const satisfies JoinRequestOrigin;
const quote = { ...origin, messageId: -501 } satisfies JoinNoticeQuote;

function fixture() {
  const values = new Map<string, string>();
  let time = 10_000;
  const storage = {
    async read(key: string) { return values.get(key) ?? null; },
    async write(key: string, value: string) { values.set(key, value); },
    async claim(key: string, value: string) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async release(key: string, value: string) { if (values.get(key) === value) values.delete(key); },
  };
  return {
    restart: () => createGroupJoinReview(() => storage, () => time),
    expire() { time += 3_600_001; },
  };
}

test("跨重启恢复按协议、机器人和群绑定的最新通知，核对原申请并在一小时后失效", async () => {
  const { restart, expire } = fixture();
  const first = restart();
  await first.record(origin, quote.messageId);
  await first.record({ ...origin, flag: "402" }, -502);

  const second = restart();
  const written: string[] = [];
  let noticeValid = true;
  const transport = {
    active: () => true, verifyNotice: async () => noticeValid, authorize: async () => true,
    verifyPending: async (request: JoinRequestOrigin) => request.flag === "401" ? "pending" as const : "risk" as const,
    async submit(request: JoinRequestOrigin) { written.push(request.flag); return "confirmed" as const; },
  };
  for (const other of [{ ...quote, adapter: "milky" as const, messageId: 501 }, { ...quote, botId: 102 }, { ...quote, groupId: 202 }]) {
    expect(await second.quoted(other, transport)).toEqual({ status: "unrelated" });
  }
  noticeValid = false;
  expect(await second.quoted(quote, transport)).toEqual({ status: "unrelated" });
  noticeValid = true;
  expect(await second.quoted({ ...quote, messageId: -502 }, transport)).toEqual({ status: "risk" });
  expect(await second.quoted(quote, transport)).toMatchObject({ status: "confirmed", userId: 301 });
  expire();
  expect(await restart().quoted(quote, transport)).toEqual({ status: "expired" });
  expect(written).toEqual(["401"]);
});

test("引用与主人私聊共用审批占用，跨进程保留未知结果，明确拒绝才允许重试", async () => {
  const { restart } = fixture();
  const first = restart();
  const second = restart();
  await first.record(origin, quote.messageId);

  const inFlight = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>();
  const transport = {
    active: () => true, verifyNotice: async () => true, authorize: async () => true,
    verifyPending: async () => "pending" as const,
    async submit() { writeStarted.resolve(); await inFlight.promise; return "unknown" as const; },
  };
  const attempt = first.quoted(quote, transport);
  await writeStarted.promise;
  let privateCalls = 0;
  const approvePrivately = () => confirmJoinReview(second, origin, async () => { privateCalls++; return true; });
  await expect(approvePrivately()).rejects.toThrow("审批结果未确认");
  inFlight.resolve();
  expect(await attempt).toMatchObject({ status: "unknown" });
  await expect(approvePrivately()).rejects.toThrow("审批结果未确认");
  expect(privateCalls).toBe(0);

  const rejected = { ...origin, flag: "another" };
  expect(await confirmJoinReview(first, rejected, async () => false)).toBe(false);
  expect(await confirmJoinReview(second, rejected, async () => true)).toBe(true);
});
