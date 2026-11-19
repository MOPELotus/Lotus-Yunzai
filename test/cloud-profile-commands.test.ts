import { expect, test } from "bun:test";
import { ProfileError } from "@lotus-yunzai/account";
import { CloudGenshinWalletError } from "../packages/hoyo-client/cloud-genshin-wallet.ts";
import { cloudProfileCommands, isCloudTokenInput } from "../lib/cloud-profile-commands.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";

const browserCombo = "ai=4;ci=1;oi=fixture-open;ct=fixture%2Bopaque==;si=fixture-sig;bi=hk4e_cn";
const androidCombo = "ai=7;ci=1;oi=fixture-open;ct=fixture-nap;si=fixture-sig;bi=nap_cn";
const genshin = `#绑定云原神token2 ${browserCombo}`;
const zzz = "#绑定云绝区零token2 fixture-zzz-secret";

function context(message: string, overrides: Partial<MessageFallbackContext> = {}): MessageFallbackContext {
  return {
    normalizedMessage: message, raw_message: message, message_type: "private", self_id: 99, user_id: 42,
    isMaster: false, isBotMaster: () => false, reply: () => true, ...overrides,
  };
}

test("两种云凭据前缀由原生模块识别，只有原认证好友私聊可开始核验", async () => {
  for (const value of [genshin, zzz, "＃ 绑定 云 原神 TOKEN-2\nxyz", "#绑定云绝区零token", "/绑定云原神ToKeN256"]) {
    expect(isCloudTokenInput(value)).toBe(true);
  }
  for (const value of ["#启用云原神签到2", "请看 #绑定云原神token", "#绑定云雷电token"]) {
    expect(isCloudTokenInput(value)).toBe(false);
  }
  const calls: string[] = [];
  const native = cloudProfileCommands({
    signal: new AbortController().signal,
    async readProfile() { calls.push("read"); return { loggedIn: true, revision: "r1" }; },
    async readWallet() { calls.push("wallet"); return { freeTimeMinutes: 0 }; },
    async saveToken() { calls.push("save"); },
    async setEnabled() { calls.push("toggle"); },
    viewProfile() { calls.push("view"); return "资料卡"; },
  });
  const session = new AbortController();
  const run = (message: string, overrides?: Partial<MessageFallbackContext>) => native.fallback!(message, context(message, overrides));
  expect(await run(genshin, { message_type: "group", privateCredentialSignal: session.signal })).toBe("请勿在群聊或终端发送云游戏凭据。");
  expect(await run(zzz, { message_type: "terminal" })).toBe("请勿在群聊或终端发送云游戏凭据。");
  expect(await run(zzz, { privateCredentialSignal: session.signal })).toBe("请输入有效的云绝区零凭据。");
  expect(await run(genshin)).toBe("请从当前连接的机器人好友私聊绑定云原神凭据。");
  expect(await run("#未知指令", { raw_message: genshin })).toContain("#绑定云原神token");
  expect(await run(genshin.replace("token2", "token02"), { privateCredentialSignal: session.signal })).toBe("档案编号须在 1 到 255 之间。");
  expect(calls).toEqual([]);
});

test("两种云游戏凭据仅交对应钱包核验并提交当前 QQ 与档案，回执不接收原指令", async () => {
  const session = new AbortController();
  const lifecycle = new AbortController();
  const steps: unknown[][] = [];
  const native = cloudProfileCommands({
    signal: lifecycle.signal,
    async readProfile(qq, slot) {
      steps.push(["profile", qq, slot]);
      return { loggedIn: true, revision: "rev-2" };
    },
    async readWallet(token, _transport, options) {
      expect(token).toBe(browserCombo);
      expect(options?.signal?.aborted).toBe(false);
      await options?.verifyProfile?.();
      steps.push(["wallet", "genshin"]);
      return { freeTimeMinutes: 0 };
    },
    async readZzzWallet(token, _transport, options) {
      expect(token).toBe(androidCombo);
      expect(options?.signal?.aborted).toBe(false);
      await options?.verifyProfile?.();
      steps.push(["wallet", "zzz"]);
      return { freeTimeMinutes: 0 };
    },
    async saveToken(qq, slot, revision, game, token, signal) {
      expect(signal.aborted).toBe(false);
      expect(token).toBe(game === "genshin" ? browserCombo : androidCombo);
      steps.push(["save", qq, slot, revision, game]);
    },
    async setEnabled() { throw new Error("only token write should happen"); },
    viewProfile(slot, event) {
      expect(event.raw_message).toBeUndefined();
      expect(event.message).toBeUndefined();
      expect("normalizedMessage" in event).toBe(false);
      steps.push(["card", slot, event.user_id]);
      return "资料卡";
    },
  });
  for (const [game, message] of [["genshin", genshin], ["zzz", `#绑定云绝区零token2 ${androidCombo}`]]) {
    steps.length = 0;
    expect(await native.fallback!(message!, context(message!, { privateCredentialSignal: session.signal }))).toBe("资料卡");
    expect(steps).toEqual([
      ["profile", "42", 2], ["profile", "42", 2], ["profile", "42", 2], ["wallet", game],
      ["profile", "42", 2], ["save", "42", 2, "rev-2", game], ["card", 2, 42],
    ]);
  }
});

test("换绑、断线、失效及钱包错误均保留旧配置", async () => {
  for (const mode of ["changed", "disconnect", "expired", "transport"] as const) {
    const session = new AbortController();
    let current = true;
    let reads = 0;
    let saved = 0;
    const native = cloudProfileCommands({
      signal: new AbortController().signal,
      async readProfile() { return { loggedIn: true, revision: current ? "r1" : "r2" }; },
      async readWallet() {
        reads++;
        if (mode === "changed") current = false;
        if (mode === "disconnect") session.abort();
        if (mode === "expired") throw new CloudGenshinWalletError("expired", 200, -100);
        if (mode === "transport") throw new Error(browserCombo);
        return { freeTimeMinutes: 12 };
      },
      async saveToken() { saved++; },
      async setEnabled() { throw new Error("toggle unexpected"); },
      viewProfile() { throw new Error("view unexpected"); },
    });
    const reply = await native.fallback!(genshin, context(genshin, { privateCredentialSignal: session.signal }));
    expect(reply).toBe({
      changed: "档案已变更，请重新绑定云原神凭据。", disconnect: undefined,
      expired: "云原神凭据已失效，请在官方客户端重新登录后绑定。", transport: "暂时无法读取云原神钱包，档案未更新。",
    }[mode]);
    expect(saved).toBe(0);
    expect(reads).toBe(1);
  }
});

test("云原神和云绝区零的旧开关只更新当前档案旗标", async () => {
  const writes: unknown[][] = [];
  const native = cloudProfileCommands({
    signal: new AbortController().signal,
    async readProfile(qq, slot) {
      if (slot === 3) throw new ProfileError("missing", "fixture");
      expect(qq).toBe("42");
      return { loggedIn: true, revision: `r${slot}` };
    },
    async readWallet() { throw new Error("flag should not hit the wallet"); },
    async saveToken() { throw new Error("flag should not store a credential"); },
    async setEnabled(...settings) { writes.push(settings); },
    viewProfile(slot) { return `资料卡 ${slot}`; },
  });
  const run = (message: string, overrides?: Partial<MessageFallbackContext>) => native.fallback!(message, context(message, overrides));
  expect(await run("#启用云原神签到2", { message_type: "group", group_id: 77 })).toBe("资料卡 2");
  expect(await run("#禁用云原神2")).toBe("资料卡 2");
  expect(await run("#开启云绝区零")).toBe("资料卡 1");
  expect(await run("#关闭云绝区零签到")).toBe("资料卡 1");
  expect(await run("#启用云绝区零签到3")).toBe("请先登录 profile 3。");
  expect(await run("#启用云原神签到256")).toBe("档案编号须在 1 到 255 之间。");
  expect(await run("#启用云绝区零", { message_type: "terminal" })).toBe("请从对应的 QQ 会话设置云游戏。");
  expect(writes).toEqual([
    ["42", 2, "r2", "genshin", true], ["42", 2, "r2", "genshin", false],
    ["42", 1, "r1", "zzz", true], ["42", 1, "r1", "zzz", false],
  ]);
});
