import { expect, test } from "bun:test";
import { notifyOnlineMasters, onlineNoticeSeconds } from "../lib/online-notice.ts";

test("上线通知冷却按分钟配置，默认一天，正小数向上取整到秒", () => {
  expect(onlineNoticeSeconds(undefined)).toBe(86_400);
  expect(onlineNoticeSeconds(1440)).toBe(86_400);
  expect(onlineNoticeSeconds(" 0.5 ")).toBe(30);
  expect(onlineNoticeSeconds(".025")).toBe(2);
  expect(onlineNoticeSeconds("2.")).toBe(120);
  expect(onlineNoticeSeconds(Number.MIN_VALUE)).toBe(1);
  for (const invalid of [0, -0, false, null, "0", " .0 ", "", "   ", true, -1, "-0.5", "0x4", "1e3", NaN,
    Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, [], {}, "no"]) {
    expect(onlineNoticeSeconds(invalid)).toBeUndefined();
  }
});

test("只对有效账号和有效主人争用锁，并重读权限后去重私聊目标", async () => {
  let owners = [21];
  let reads = 0;
  const claims: number[][] = [];
  const sends: [number, number, string][] = [];
  const options = {
    masterIds(botId: number) {
      expect(botId).toBe(99);
      reads++;
      return owners;
    },
    async claim(botId: number, seconds: number) {
      claims.push([botId, seconds]);
      owners = [22, 22, 99, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1];
      return true;
    },
    async send(botId: number, userId: number, message: string) { sends.push([botId, userId, message]); },
  };

  await notifyOnlineMasters(0, 60, options);
  await notifyOnlineMasters(99, undefined, options);
  await notifyOnlineMasters(99, Number.MAX_SAFE_INTEGER, options);
  expect(reads).toBe(0);
  await notifyOnlineMasters(99, 60, options);
  expect(reads).toBe(2);
  expect(claims).toEqual([[99, 60]]);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toEqual([99, 22, expect.stringMatching(/^欢迎使用【Lotus-Yunzai】\n/u)]);
  expect(sends[0]?.[2]).toContain("【#安装插件】");
});

test("没有有效主人、未取得冷却或存储出错时不发送通知", async () => {
  let claims = 0;
  const send = async () => { throw new Error("不应发送。"); };
  const options = {
    masterIds: () => [99, -1, 0, 1.5],
    async claim() { claims++; return true; },
    send,
  };
  await notifyOnlineMasters(99, 60, options);
  await notifyOnlineMasters(99, 60, { ...options, signal: AbortSignal.abort() });
  expect(claims).toBe(0);

  let tries = 0;
  let sends = 0;
  const rejected = {
    masterIds: () => [21],
    async claim() {
      if (++tries === 1) return false;
      throw new Error("测试存储不可用。");
    },
    async send() { sends++; },
  };
  await notifyOnlineMasters(99, 60, rejected);
  await notifyOnlineMasters(99, 60, rejected);
  expect(tries).toBe(2);
  expect(sends).toBe(0);
});

test("并发连接向冷却取得者放行，每个主人至多尝试一次", async () => {
  let claimed = false;
  const attempts: number[] = [];
  const options = {
    masterIds: () => [21, 21, 22, 23],
    async claim() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    async send(_botId: number, userId: number) {
      attempts.push(userId);
      if (userId === 21) throw new Error("测试协议结果未确认。");
      return userId !== 22;
    },
  };
  await Promise.all([notifyOnlineMasters(99, 60, options), notifyOnlineMasters(99, 60, options)]);
  expect(attempts).toEqual([21, 22, 23]);
});

test("等待冷却或上一条发送时收到停止信号，不开始后续发送", async () => {
  const stopping = new AbortController();
  const entered = Promise.withResolvers<void>();
  const claimed = Promise.withResolvers<boolean>();
  const attempts: number[] = [];
  const pending = notifyOnlineMasters(99, 60, {
    signal: stopping.signal, masterIds: () => [21, 22],
    claim() {
      entered.resolve();
      return claimed.promise;
    },
    async send(_bot, user) { attempts.push(user); },
  });
  await entered.promise;
  stopping.abort();
  claimed.resolve(true);
  await pending;
  expect(attempts).toEqual([]);

  const duringSend = new AbortController();
  await notifyOnlineMasters(99, 60, {
    signal: duringSend.signal, masterIds: () => [21, 22],
    async claim() { return true; },
    async send(_bot, user) {
      attempts.push(user);
      duringSend.abort();
    },
  });
  expect(attempts).toEqual([21]);
});
