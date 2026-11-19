import { expect, test } from "bun:test";
import type { GachaExpectationRequest } from "@lotus-yunzai/gacha/expectation";
import { GachaReturnSimulationBusyError, type GachaCharacterReturnRequest } from "@lotus-yunzai/gacha/character-returns";
import { CommandRegistry, sendCommandReply } from "../lib/commands.ts";
import { gachaExpectationCommands, gachaExpectationModuleName, isGachaExpectationInput } from "../lib/gacha-expectation-commands.ts";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";

function fixture(compute: Parameters<typeof gachaExpectationCommands>[0] = async (request) => ({
  mean: 99.2, p25: 73, p50: 94, p75: 132, p90: 154, p95: 162,
  budgetChance: request.budget === undefined ? undefined : request.budget === 0 ? 0 : 0.75,
}), sample?: Parameters<typeof gachaExpectationCommands>[1]) {
  const registry = new CommandRegistry();
  const calls: GachaExpectationRequest[] = [];
  const replies: { message: MessageReply; quote: boolean }[] = [];
  registry.registerModule(gachaExpectationCommands((request) => {
    calls.push(request);
    return compute(request);
  }, sample));
  async function send(text: string, enabled = true, normalized = text, calculationSignal?: AbortSignal) {
    const event: MessageEvent & { calculationSignal?: AbortSignal } = {
      msg: text, raw_message: text, message: text, post_type: "message", message_type: "group",
      message_id: 88, self_id: 100, group_id: 10, user_id: 42, isGroup: true, isPrivate: false, isMaster: false,
      calculationSignal,
      reply: (message, quote = false) => { replies.push({ message, quote }); return true; },
    };
    const reply = await registry.dispatchFallback(event, (names) => enabled && names[0] === gachaExpectationModuleName,
      () => false, normalized);
    if (reply !== undefined) await sendCommandReply(event, reply);
  }
  return { calls, replies, send };
}

test("抽卡命令保留紧连参数、旧别名、默认状态和最后指定值", async () => {
  const { calls, replies, send } = fixture();
  await send(" #期望计算GENSHIN 音擎 1精 50垫 不歪 定轨值1 持有200发 ");
  await send("#期望计算 3个 2魂 人物 崩铁 7抽 8垫 必出 小保底");
  await send("#期望计算 ZZZ 音擎");
  expect(calls).toEqual([
    { pool: "genshin-weapon", copies: 1, pity: 50, guaranteed: false, fate: 1, radiance: undefined, budget: undefined },
    { pool: "hsr-character", copies: 2, pity: 8, guaranteed: false, fate: undefined, radiance: undefined, budget: undefined },
    { pool: "zzz-weapon", copies: 1, pity: 0, guaranteed: false, fate: undefined, radiance: undefined, budget: undefined },
  ]);
  expect(replies.map(({ quote }) => quote)).toEqual([false, true, false, true, false, true]);
  expect(replies[1]?.message).toContain("原神 定轨武器");
  expect(replies[1]?.message).toContain("已垫 50 抽 · 大保底\n定轨值 1");
  expect(replies[1]?.message).toContain("期望抽数 99.20 抽");
  expect(replies[1]?.message).toContain("按旧卡池模型估算");
  expect(replies[1]?.message).toContain("预算达成率");
  expect(replies[1]?.message).toContain("16,000 原石");
  expect(replies[1]?.message).not.toContain("95%");
  expect(replies[3]?.message).toContain("星琼");
  expect(replies[5]?.message).toContain("菲林");
});

test("分布报告展示分位与含零预算的达成率", async () => {
  const { calls, replies, send } = fixture();
  await send("荷花 ＃期望分布", true, "#期望分布 原神 角色 20个 89垫 明光计数3 UP4C6 目标0");
  await send("#期望分布 HSR 光锥 2张 79抽 大保底 预算180抽");
  expect(calls.map(({ pool, pity, copies, radiance, budget }) => [pool, pity, copies, radiance, budget])).toEqual([
    ["genshin-character", 89, 20, 3, 0], ["hsr-lightcone", 79, 2, undefined, 180],
  ]);
  expect(replies[1]).toMatchObject({ quote: true });
  expect(replies[1]?.message).toContain("25% · 73 抽\n50% · 94 抽\n75% · 132 抽\n90% · 154 抽\n95% · 162 抽");
  expect(replies[1]?.message).toContain("预算 0 抽 · 达成率 0.00%");
  expect(replies[1]?.message).toContain("四星满命状态和兑换道具返还尚未纳入计算");
  expect(replies[3]?.message).toContain("预算 180 抽 · 达成率 75.00%");
});

test("空参数、非法卡池和越界数字不会开始计算", async () => {
  const { calls, replies, send } = fixture();
  const bad = [
    ["", "请填写游戏和卡池"], ["星铁 武器", "没有可计算"], ["原神 角色 非法", "参数无法识别"],
    ["绝区零 音擎 四星满命", "仅适用于角色池"], ["绝区零 人物 明光0", "仅适用于原神角色池"],
    ["原神 角色 明光4", "0 到 3"], ["原神 角色 定轨0", "仅适用于原神武器池"], ["原神 武器 定轨2", "0 到 1"],
    ["原神 武器 80垫", "0 到 79"], ["星铁 角色 90垫", "0 到 89"], ["绝区零 人物 0个", "1 到 20"],
    ["原神 角色 21个", "1 到 20"], ["原神 角色 预算9007199254740992", "数值过大"],
  ];
  for (const [input] of bad) await send(`#期望分布 ${input}`);
  expect(calls).toEqual([]);
  expect(replies).toHaveLength(bad.length);
  for (const [index, [, message]] of bad.entries()) {
    expect(replies[index]?.quote).toBe(false);
    expect(replies[index]?.message).toContain(message);
  }
});

test("帮助直接发送，权限关闭不响应，计算异常以引用回复", async () => {
  const { calls, replies, send } = fixture(() => { throw new Error("private computation details"); });
  await send("#期望计算帮助");
  await send("#期望分布 原神 角色", false);
  await send("其他功能 #期望计算 原神 角色");
  await send("#期望计算 原神 角色\n无关消息");
  await send("#期望计算 原神 角色");
  expect(isGachaExpectationInput(" #期望计算帮助 ")).toBe(true);
  expect(isGachaExpectationInput("#期望计算GENSHIN 角色")).toBe(true);
  expect(isGachaExpectationInput("请发 #期望计算帮助")).toBe(false);
  expect(replies).toHaveLength(3);
  expect(replies[0]?.message).toContain("#期望分布");
  expect(replies[0]?.message).toContain("按旧卡池模型估算");
  expect(replies[0]?.quote).toBe(false);
  expect(replies[1]).toMatchObject({ message: "正在计算平均抽数…", quote: false });
  expect(replies[2]).toMatchObject({ message: "抽卡计算暂未完成，请稍后重试。", quote: true });
  expect(calls).toHaveLength(1);
});

test("三个角色池的分布估算各自返还，保留旧四星开关和当前会话信号", async () => {
  const sampled: GachaCharacterReturnRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const signal = new AbortController().signal;
  const { replies, send } = fixture(undefined, async (request, options) => {
    sampled.push(request);
    signals.push(options?.signal);
    return { mean: 31.253, p25: 20, p50: 30, p75: 42, p90: 54, p95: 57 };
  });
  await send("#期望分布 原神 角色 2命 明光2 UP4满命", true, undefined, signal);
  await send("#期望分布 星铁 人物 四星满命 必出");
  await send("#期望分布 绝区零 角色");
  await send("#期望计算 原神 角色 UP4C6");
  await send("#期望分布 绝区零 音擎");
  expect(sampled.map(({ pool, up4C6 }) => [pool, up4C6])).toEqual([
    ["genshin-character", true], ["hsr-character", true], ["zzz-character", false],
  ]);
  expect(sampled[0]).toMatchObject({ copies: 2, radiance: 2, up4C6: true });
  expect(sampled[1]).toMatchObject({ guaranteed: true });
  expect(signals).toEqual([signal, undefined, undefined]);
  expect(replies[1]?.message).toContain("预计返还星辉（模拟） · UP 四星已满命\n平均 31.25 个");
  expect(replies[3]?.message).toContain("预计返还星芒（模拟）");
  expect(replies[5]?.message).toContain("预计返还信号余波（模拟） · UP 四星未满命");
  expect(replies[5]?.message).toContain("25% 分位 20 个 · 50% 分位 30 个 · 75% 分位 42 个");
  expect(replies[7]?.message).not.toContain("预计返还");
  expect(replies[9]?.message).not.toContain("预计返还");
});

test("返还繁忙时仍提供抽数，取消后不发送最终回复", async () => {
  const busy = fixture(undefined, () => { throw new GachaReturnSimulationBusyError(); });
  await busy.send("#期望分布 原神 角色");
  expect(busy.replies[1]?.message).toContain("期望抽数 99.20 抽");
  expect(busy.replies[1]?.message).toContain("返还估算正在处理另一条请求");

  const controller = new AbortController();
  const canceled = fixture(undefined, async (_request, options) => {
    expect(options?.signal).toBe(controller.signal);
    controller.abort();
    options?.signal?.throwIfAborted();
    throw new Error("unreachable");
  });
  await canceled.send("#期望分布 原神 角色", true, undefined, controller.signal);
  await canceled.send("#期望计算帮助", true, undefined, controller.signal);
  expect(canceled.replies).toEqual([{ message: "正在计算抽数分布…", quote: false }]);
});
