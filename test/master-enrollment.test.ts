import { expect, test } from "bun:test";
import { createMasterEnrollment, matchesMasterEnrollment } from "../lib/master-enrollment.ts";
import type { MessageEvent } from "../lib/messages.ts";

type Grant = Parameters<typeof createMasterEnrollment>[0]["grant"];

function fixture(onGrant?: Grant) {
  const masters = new Map([[99, new Set([51, 56])], [100, new Set([52])]]);
  const attempts: [number, number, number | "stdin"][] = [];
  let terminalAllowed = false;
  let now = 0;
  const handle = createMasterEnrollment({
    isMaster: (bot, user) => masters.get(bot)?.has(user) ?? false,
    masterIds: (bot) => [...(masters.get(bot) ?? [])],
    isTerminalMaster: () => terminalAllowed,
    grant: async (...args) => {
      const [bot, user, approver] = args;
      attempts.push([bot, user, approver]);
      if (onGrant && !await onGrant(...args)) return false;
      const owners = masters.get(bot) ?? new Set<number>();
      owners.add(user);
      masters.set(bot, owners);
      return true;
    },
  }, () => now);

  async function send(msg: string, fields: Partial<MessageEvent> = {}) {
    const replies: string[] = [];
    const handled = await handle({
      msg, raw_message: msg, message: msg,
      post_type: "message", message_type: "private", boundAccount: true,
      self_id: 99, user_id: 42, isGroup: false, isPrivate: true, isMaster: false,
      reply(message) {
        expect(typeof message).toBe("string");
        replies.push(message as string);
        return true;
      },
      ...fields,
    });
    return { handled, text: replies.join("\n") };
  }

  return {
    send, attempts, masters,
    allowTerminal: () => { terminalAllowed = true; },
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

function token(text: string, pattern: RegExp): string {
  const value = pattern.exec(text)?.[1];
  expect(value).toBeDefined();
  return value!;
}

test("设置主人入口只匹配完整命令，已绑定私聊申请才发编号", async () => {
  for (const message of ["#设置主人", "  #设置主人 一次性输入", "#设置主人验证码\t12345678"]) {
    expect(matchesMasterEnrollment(message)).toBe(true);
  }
  for (const message of ["设置主人", "#设置主人资料", "#设置主人验证码ABC", "其他 #设置主人"]) {
    expect(matchesMasterEnrollment(message)).toBe(false);
  }
  const { send, attempts } = fixture();
  expect(await send("#状态")).toEqual({ handled: false, text: "" });
  expect((await send("#设置主人", { message_type: "group", group_id: 77 })).text).toContain("已绑定机器人的私聊");
  expect((await send("#设置主人", { boundAccount: false })).text).toContain("已绑定机器人的私聊");
  expect((await send("#设置主人", { self_id: 101 })).text).toContain("尚未设置主人");
  expect((await send("#设置主人", { self_id: 42 })).text).toContain("已绑定机器人的私聊");
  expect(attempts).toEqual([]);
});

test("验证码受签发人、机器人、申请人约束，重新签发使旧验证码失效", async () => {
  const { send, attempts, masters } = fixture();
  const requested = await send("#设置主人");
  const id = token(requested.text, /申请编号：([a-f0-9]{8})/u);
  expect(requested.text).not.toMatch(/验证码：[a-f0-9]{16}/u);
  expect((await send("#设置主人")).text).toEqual(requested.text);

  const issue = `#设置主人验证码 ${id}`;
  expect((await send(issue, { isMaster: true })).text).toContain("仅当前机器人的主人");
  expect((await send(issue, { self_id: 100, user_id: 52 })).text).toContain("无效");
  expect((await send(issue, { user_id: 51, message_type: "group", group_id: 77 })).text).not.toContain("验证码：");
  expect((await send(issue, { user_id: 51, boundAccount: false })).text).not.toContain("验证码：");
  const initiallySigned = token((await send(issue, { user_id: 51 })).text, /验证码：([a-f0-9]{16})/u);
  const rotated = await send(issue, { user_id: 56 });
  const code = token(rotated.text, /验证码：([a-f0-9]{16})/u);
  expect(rotated.text).toContain("申请人 QQ：42");
  expect(code).not.toBe(initiallySigned);
  expect((await send(`#设置主人 ${initiallySigned}`)).text).toContain("无效");
  expect((await send(`#设置主人 ${code}`, { self_id: 100 })).text).toContain("无效");
  expect((await send(`#设置主人 ${code}`, { user_id: 43 })).text).toContain("无效");
  const completed = await send(`#设置主人 ${code.toUpperCase()}`);
  expect(completed.text).toContain("已设置为当前机器人的主人");
  expect(completed.text).not.toContain(code);
  expect(masters.get(99)?.has(42)).toBe(true);
  expect(masters.get(100)?.has(42)).toBe(false);
  expect((await send(`#设置主人 ${code}`)).text).toContain("已经是当前机器人的主人");
  expect(attempts).toEqual([[99, 42, 56]]);
});

test("申请与验证码到期作废，撤销签发者后不能继续授权", async () => {
  const { send, advance, masters, attempts } = fixture();
  const request = () => send("#设置主人");
  const idOf = async () => token((await request()).text, /申请编号：([a-f0-9]{8})/u);
  const issue = (id: string) => send(`#设置主人验证码 ${id}`, { user_id: 51 });
  const codeOf = async (id: string) => token((await issue(id)).text, /验证码：([a-f0-9]{16})/u);
  const first = await idOf();
  advance(300_000);
  expect((await issue(first)).text).toContain("无效");

  const next = await idOf();
  advance(299_000);
  const expiring = await codeOf(next);
  advance(1_000);
  expect((await send(`#设置主人 ${expiring}`)).text).toContain("无效");

  const revoked = await codeOf(await idOf());
  masters.get(99)!.delete(51);
  expect((await send(`#设置主人 ${revoked}`)).text).toContain("无效");
  masters.get(99)!.add(51);
  expect((await send(`#设置主人 ${revoked}`)).text).toContain("无效");
  expect(attempts).toEqual([]);
});

test("并发提交只能执行一次写入，写入失败不回显或重新启用验证码", async () => {
  const started = Promise.withResolvers<void>();
  const persisted = Promise.withResolvers<boolean>();
  const { send, attempts, masters } = fixture(async () => {
    started.resolve();
    return persisted.promise;
  });
  const id = token((await send("#设置主人")).text, /申请编号：([a-f0-9]{8})/u);
  const code = token((await send(`#设置主人验证码 ${id}`, { user_id: 51 })).text, /验证码：([a-f0-9]{16})/u);
  const submit = `#设置主人 ${code}`;
  const first = send(submit);
  await started.promise;
  expect((await send(submit)).text).toContain("正在处理");
  persisted.reject(new Error(code));
  const failed = await first;
  expect(failed.text).toContain("无法保存");
  expect(failed.text).not.toContain(code);
  expect((await send(submit)).text).toContain("无效");
  expect(masters.get(99)?.has(42)).toBe(false);
  expect(attempts).toEqual([[99, 42, 51]]);
});

test("Milky 主人申请和验证码只在同适配器同账号的有效私聊会话中使用", async () => {
  let active = true;
  const milky = { adapter: "milky", boundAccount: false, isOwnerEnrollmentSession: () => active } as const;
  const { send, attempts, masters } = fixture();
  for (const check of [undefined, () => false, () => { throw new Error("private session sentinel"); }]) {
    const result = await send("#设置主人", { ...milky, boundAccount: true, isOwnerEnrollmentSession: check });
    expect(result.text).toContain("已绑定机器人的私聊");
    expect(result.text).not.toContain("private session sentinel");
  }
  expect((await send("#设置主人", { ...milky, message_type: "group", group_id: 77 })).text)
    .toContain("已绑定机器人的私聊");

  const id = token((await send("#设置主人", milky)).text, /申请编号：([a-f0-9]{8})/u);
  const issue = `#设置主人验证码 ${id}`;
  expect((await send(issue, { user_id: 51 })).text).toContain("无效");
  expect((await send(issue, { ...milky, self_id: 100, user_id: 52 })).text).toContain("无效");
  const code = token((await send(issue, { ...milky, user_id: 51 })).text, /验证码：([a-f0-9]{16})/u);
  const submit = `#设置主人 ${code}`;
  expect((await send(submit)).text).toContain("无效");
  expect((await send(submit, { ...milky, user_id: 43 })).text).toContain("无效");

  active = false;
  expect((await send(submit, milky)).text).toContain("已绑定机器人的私聊");
  expect(attempts).toEqual([]);
  const freshMilky = { ...milky, isOwnerEnrollmentSession: () => true };
  expect((await send(submit, freshMilky)).text).toContain("已设置为当前机器人的主人");
  expect((await send("#设置主人")).text).toContain("已经是当前机器人的主人");
  expect(masters.get(99)?.has(42)).toBe(true);
  expect(attempts).toEqual([[99, 42, 51]]);
});

test("两种协议的申请独立，同账号并发保存互斥并在提交前复核 Milky 会话", async () => {
  const saving = Promise.withResolvers<void>();
  const continueSave = Promise.withResolvers<void>();
  let active = true;
  const milky = { adapter: "milky", boundAccount: false, isOwnerEnrollmentSession: () => active } as const;
  const { send, attempts, masters } = fixture(async (_bot, _user, approver, guard) => {
    if (approver === 56) {
      expect(guard?.()).toBe(true);
      saving.resolve();
      await continueSave.promise;
      return guard?.() === true;
    }
    expect(guard).toBeUndefined();
    return true;
  });
  async function codeFor(approver: number, fields: Partial<MessageEvent>) {
    const id = token((await send("#设置主人", fields)).text, /申请编号：([a-f0-9]{8})/u);
    return token((await send(`#设置主人验证码 ${id}`, { ...fields, user_id: approver })).text, /验证码：([a-f0-9]{16})/u);
  }
  const milkyCode = await codeFor(56, milky);
  const oneBotCode = await codeFor(51, {});
  const first = send(`#设置主人 ${milkyCode}`, milky);
  try {
    expect(await Promise.race([saving.promise.then(() => true), first.then(() => false)])).toBe(true);
    expect((await send(`#设置主人 ${oneBotCode}`)).text).toContain("正在处理");
    expect(attempts).toEqual([[99, 42, 56]]);
    active = false;
  } finally {
    continueSave.resolve();
  }
  expect((await first).text).toContain("无法保存");
  expect(masters.get(99)?.has(42)).toBe(false);
  expect((await send(`#设置主人 ${oneBotCode}`)).text).toContain("已设置为当前机器人的主人");
  expect(attempts).toEqual([[99, 42, 56], [99, 42, 51]]);
});

test("首位主人可由配置授权的终端设置，非法或溢出的 QQ 不传给落盘函数", async () => {
  const { send, attempts, allowTerminal, masters } = fixture();
  const terminal = { message_type: "terminal", isMaster: true } as const;
  expect((await send("#设置主人 101 46", terminal)).text).toContain("stdin:stdin");
  allowTerminal();
  for (const argumentsText of ["101", "101 46 52", "101 046", "101 -1", "101 9007199254740992", "101 101"]) {
    expect((await send(`#设置主人 ${argumentsText}`, terminal)).text).toContain("用法");
  }
  expect((await send("#设置主人验证码 12345678", terminal)).text).toContain("用法");
  expect(attempts).toEqual([]);
  expect((await send("#设置主人 101\t46", terminal)).text).toContain("已设置");
  expect(attempts).toEqual([[101, 46, "stdin"]]);
  expect(masters.get(101)?.has(46)).toBe(true);
});
