import { expect, test } from "bun:test";
import { CommandRegistry } from "../lib/commands.ts";
import type { MessageEvent } from "../lib/messages.ts";
import { inspectPluginMetadata } from "../lib/plugins/metadata.ts";
import { createLegacyPanelRecoveryFlow, matchLegacyPanelRecoveryConfirmation } from "../lib/legacy-panel-recovery-flow.ts";
import type { LegacyPanelRecovery } from "../lib/legacy-panel-recovery.ts";

const uid = "123450001";
const profileId = 2;
const game = "gs";
const target = { game, uid, profileId } as const;
const identity = { adapter: "onebot", bot: 42, user: 51, isCurrent: () => true, signal: new AbortController().signal } as const;
const playerData = { uid, avatars: { "10000046": { id: 10000046, name: "合成角色" } } };

function fixture() {
  let now = 100_000;
  let enabled = false;
  let canAct = true;
  let empty = true;
  let writes = 0;
  let response: LegacyPanelRecovery = { state: "ready", playerData };
  let duringRead: () => void | Promise<void> = () => undefined;
  const calls: { game: "gs" | "sr"; qq: string; uid: string }[] = [];
  const flow = createLegacyPanelRecoveryFlow({
    enabled: async () => enabled,
    authorize: async () => canAct ? async () => canAct : undefined,
    now: () => now,
    async read(request) { calls.push(request); await duringRead(); return response; },
  });
  const candidate = {
    ...target,
    async isEmpty() { return empty; },
    async save(data: Readonly<Record<string, unknown>>, verify: () => Promise<void>) {
      await verify();
      if (!empty) return;
      expect(data).toEqual(playerData);
      writes++;
      empty = false;
      return 1;
    },
  };
  return {
    flow, calls, candidate, writes: () => writes,
    enable() { enabled = true; },
    setAuthority(value: boolean) { canAct = value; },
    setEmpty(value: boolean) { empty = value; },
    setResponse(value: LegacyPanelRecovery, effect: () => void | Promise<void> = () => undefined) { response = value; duringRead = effect; },
    advance(milliseconds: number) { now += milliseconds; },
  };
}

test("默认禁用、送达后逐字同意，按协议、机器人、账号、游戏、档案及 UID 隔离", async () => {
  const { flow, calls, candidate, writes, enable } = fixture();
  expect(await flow.offer(identity)(candidate)).toBeUndefined();
  expect(await flow.confirm(target, identity)).toContain("未开启");
  enable();
  const delivery = await flow.offer(identity)(candidate);
  expect(delivery?.message).toContain("QQ");
  expect(delivery?.message).toContain("ark.ivny.cn");
  expect(delivery?.message).toContain("原站仍需");
  expect(delivery?.message).toContain(`#确认恢复旧面板 ${uid} 档案2`);
  expect(await flow.confirm(target, identity)).toContain("没有待确认");
  await delivery!.onDelivered(600);
  for (const invalid of [{ ...identity, bot: 43 }, { ...identity, user: 52 }, { ...identity, adapter: "milky" as const }]) {
    expect(await flow.confirm(target, invalid)).toContain("没有待确认");
  }
  expect(await flow.confirm({ ...target, game: "sr" }, identity)).toContain("没有待确认");
  expect(await flow.confirm({ ...target, uid: undefined }, identity)).toContain("完整确认");
  expect(await flow.confirm({ ...target, profileId: 1 }, identity)).toContain("完整确认");
  expect(calls).toHaveLength(0);
  expect(writes()).toBe(0);
  expect(await flow.confirm(target, identity)).toContain("已恢复 1 名原神角色");
  expect(calls).toEqual([{ game, uid, qq: "51" }]);
  expect(writes()).toBe(1);
  expect(await flow.confirm(target, identity)).toContain("没有待确认");
});

test("拒绝过期、换绑、原会话断开、已有面板和在途删除", async () => {
  const { flow, calls, candidate, writes, enable, advance, setAuthority, setEmpty, setResponse } = fixture();
  enable();
  const delivered = 600;
  await (await flow.offer(identity)(candidate))!.onDelivered(delivered);
  advance(5 * 60_000);
  expect(await flow.confirm(target, identity)).toContain("没有待确认");

  await (await flow.offer(identity)(candidate))!.onDelivered(delivered);
  setAuthority(false);
  expect(await flow.confirm(target, identity)).toContain("未能确认");
  expect(calls).toHaveLength(0);
  setAuthority(true);

  const controller = new AbortController();
  await (await flow.offer({ ...identity, signal: controller.signal })(candidate))!.onDelivered(delivered);
  controller.abort();
  expect(await flow.confirm(target, identity)).toContain("没有待确认");
  await (await flow.offer(identity)(candidate))!.onDelivered(delivered);
  setEmpty(false);
  expect(await flow.confirm(target, identity)).toContain("已出现面板或删除记录");
  expect(calls).toHaveLength(0);
  expect(await flow.offer(identity)(candidate)).toBeUndefined();

  setEmpty(true);
  await (await flow.offer(identity)(candidate))!.onDelivered(delivered);
  setResponse({ state: "ready", playerData }, () => setEmpty(false));
  expect(await flow.confirm(target, identity)).toContain("已保留本机档案");
  expect(writes()).toBe(0);
});

test("原站仍须通过既有验证，缺档、无效和不可用均不写入", async () => {
  const { flow, calls, candidate, writes, enable, setResponse } = fixture();
  enable();
  for (const [state, message] of [["unverified", "还未验证"], ["missing", "没有这个 UID"], ["invalid", "档案未改"],
    ["unavailable", "档案未改"]] as const) {
    setResponse({ state });
    await (await flow.offer(identity)(candidate))!.onDelivered(600);
    expect(await flow.confirm(target, identity)).toContain(message);
  }
  expect(calls).toHaveLength(4);
  expect(writes()).toBe(0);
  expect(matchLegacyPanelRecoveryConfirmation(`*确认恢复旧面板 ${uid} 档案2`)).toEqual({ game: "sr", uid, profileId: 2 });
  expect(matchLegacyPanelRecoveryConfirmation("#确认恢复旧面板")).toEqual({ game: "gs", uid: undefined, profileId: 1 });
});

test("迟到及重复回执无法覆盖或复活更晚送达的档案提示", async () => {
  const { flow, calls, candidate, enable, setResponse, advance } = fixture();
  enable();
  setResponse({ state: "missing" });
  const second = { ...candidate, uid: "123450002", profileId: 3 };
  const older = (await flow.offer(identity)(candidate))!;
  const newer = (await flow.offer(identity)(second))!;
  await newer.onDelivered(602);
  await older.onDelivered(601);
  expect(await flow.confirm(target, identity)).toContain("完整确认");
  expect(calls).toHaveLength(0);
  expect(await flow.confirm(second, identity)).toContain("没有这个 UID");
  expect(calls).toEqual([{ game, uid: second.uid, qq: "51" }]);

  await older.onDelivered(601);
  await newer.onDelivered(602);
  expect(await flow.confirm(target, identity)).toContain("没有待确认");
  expect(await flow.confirm(second, identity)).toContain("没有待确认");
  expect(calls).toHaveLength(1);

  advance(5 * 60_000);
  await older.onDelivered(601);
  expect(await flow.confirm(target, identity)).toContain("没有待确认");
  const next = (await flow.offer(identity)(candidate))!;
  await next.onDelivered(603);
  expect(await flow.confirm(target, identity)).toContain("没有这个 UID");
  expect(calls.map(request => request.uid)).toEqual([second.uid, uid]);
});

test("先报告正在处理，第二次确认不会额外请求旧站", async () => {
  const { flow, calls, candidate, enable, setResponse } = fixture();
  enable();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  setResponse({ state: "missing" }, () => {
    started.resolve();
    return finish.promise;
  });
  await (await flow.offer(identity)(candidate))!.onDelivered(600);
  const first = flow.confirm(target, identity);
  await started.promise;
  expect(await flow.confirm(target, identity)).toContain("正在处理");
  expect(calls).toHaveLength(1);
  finish.resolve();
  expect(await first).toContain("没有这个 UID");
  expect(await flow.confirm(target, identity)).toContain("没有待确认");
});

test("回补能力只传入宿主标记过的内置原铁处理器，外装同名也收不到", async () => {
  const registry = new CommandRegistry();
  const event: MessageEvent = {
    post_type: "message", message_type: "private", sub_type: "friend", self_id: 42, user_id: 51,
    isPrivate: true, isGroup: false, isMaster: false, msg: "*更新面板",
    raw_message: "*更新面板", message: "*更新面板", reply: () => true,
  };
  const { flow } = fixture();
  const offerLegacyPanelRecovery = flow.offer(identity);
  const capabilities = { offerLegacyPanelRecovery };
  const observe = { commands: {}, fallback: (_: string, context: object) =>
    Object.hasOwn(context, "offerLegacyPanelRecovery") ? "有能力" : "无能力" };
  const spoof = JSON.stringify({ name: "@lotus-yunzai/genshin", lotusYunzai: { entry: "index.ts" } });
  expect(inspectPluginMetadata("external-genshin", spoof, []).rejectionKind).toBe("built-in-directory");
  registry.registerModule({ ...observe, name: "@lotus-yunzai/genshin" }, "外装同名原神");
  registry.registerModule({ ...observe, name: "@lotus-yunzai/starrail" }, "内置星铁", { trustedLegacyPanelRecovery: true });
  expect(await registry.dispatchFallback(event, () => true, () => false, event.msg, capabilities, "@lotus-yunzai/genshin")).toBe("无能力");
  expect(await registry.dispatchFallback(event, () => true, () => false, event.msg, capabilities, "@lotus-yunzai/starrail")).toBe("有能力");
});
