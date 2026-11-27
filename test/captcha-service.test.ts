import { withCaptchaInteraction } from "../packages/hoyo-client/captcha.ts";
import { expect, test } from "bun:test";
import { createCaptchaService } from "../lib/captcha/service.ts";
import { captchaConfig, createAutomaticProviders, normalizeCaptchaProof, ProviderFailure } from "../lib/captcha/providers.ts";
import type { CaptchaChallenge, CaptchaProof } from "@lotus-yunzai/hoyo-client";

const v4 = { captchaVersion: 4, captchaId: "fixture-site", riskType: "signed:full:context" } as const;
const proof4 = (lot: string) => ({ captchaVersion: 4, captchaId: v4.captchaId, lotNumber: lot,
  captchaOutput: "output", passToken: "token", genTime: "1234" }) as const;
const wire4 = (lot: string) => ({ captcha_id: v4.captchaId, lot_number: lot, captcha_output: "output", pass_token: "token", gen_time: "1234" });

test("自动节点每轮5次、人工每轮1次，完整两轮且每次获取新挑战", async () => withCaptchaInteraction(() => true, async () => {
  const attempts: string[] = [], events: string[] = [];
  let challengeCount = 0, acceptedCount = 0;
  const service = createCaptchaService({ providers: {
    available: () => true,
    async solve(id, challenge) {
      attempts.push(id);
      if (challenge.captchaVersion !== 3) throw Error("wrong version");
      return { challenge: challenge.challenge, validate: `proof-${attempts.length}`, seccode: `proof-${attempts.length}|jordan` };
    },
  } });
  const result = await service.run({ signal: new AbortController().signal, verify: async () => {},
    async challenge() { return { captchaVersion: 3, gt: "gt", challenge: `challenge-${++challengeCount}` }; },
    async accept() { acceptedCount++; return { accepted: false }; },
    notify: event => { events.push(event.type); },
    async manualProof(challenge) {
      attempts.push("manual");
      if (challenge.captchaVersion !== 3) throw Error("wrong version");
      return { challenge: challenge.challenge, validate: `manual-${attempts.length}`, seccode: `manual-${attempts.length}|jordan` };
    },
  });
  expect(result.ok).toBe(false);
  expect(attempts).toEqual([...Array(5).fill("local"), ...Array(5).fill("ttocr"), "manual", ...Array(5).fill("local"), ...Array(5).fill("ttocr"), "manual"]);
  expect(challengeCount).toBe(22);
  expect(acceptedCount).toBe(22);
  expect(events).toEqual(["automatic", "failed"]);
}));

test("本地v4通过后业务接受即结束，不花费TTOCR也不等待人工", async () => {
  const attempted: string[] = [];
  const service = createCaptchaService({ providers: { available: () => true, async solve(id, challenge) {
    attempted.push(id); expect(challenge).toEqual(v4); return proof4("first");
  } } });
  const result = await service.run({ signal: new AbortController().signal, verify: async () => {}, challenge: async () => v4,
    async accept(proof) { expect(proof).toEqual(proof4("first")); return { accepted: true, value: "official-result" }; } });
  expect(result).toEqual({ ok: true, value: "official-result" });
  expect(attempted).toEqual(["local"]);
});

test("不复用v3挑战、validate或v4 lot，同站点v4可重新取题", async () => {
  let count = 0, accepted = 0;
  const service = createCaptchaService({ providers: { available: id => id === "local", async solve() { return proof4("same-lot"); } } });
  const result = await service.run({ signal: new AbortController().signal, verify: async () => {}, challenge: async () => { count++; return v4; },
    accept: async () => { accepted++; return { accepted: false }; }, allowManual: false });
  expect(result.ok).toBe(false); expect(count).toBe(10); expect(accepted).toBe(1);
  const c3 = { captchaVersion: 3, gt: "gt", challenge: "same-challenge" } as const;
  let solves = 0;
  const legacy = createCaptchaService({ providers: { available: () => true, async solve() { solves++; throw new ProviderFailure("failed"); } } });
  expect(await legacy.run({ signal: new AbortController().signal, verify: async () => {}, challenge: async () => c3,
    accept: async () => ({ accepted: false }) })).toEqual({ ok: false, reason: "challenge_reused" });
  expect(solves).toBe(1);
});

test("业务网络错误、账号变更和取消直接停止，不继续请求挑战", async () => {
  for (const mode of ["business", "changed", "cancelled"] as const) {
    const controller = new AbortController();
    let challenges = 0, guards = 0;
    const service = createCaptchaService({ providers: { available: () => true, async solve() {
      if (mode === "cancelled") controller.abort();
      return proof4("lot");
    } } });
    await expect(service.run({ signal: controller.signal,
      async verify() { if (mode === "changed" && ++guards >= 4) throw Error("changed"); },
      async challenge() { challenges++; return v4; },
      async accept() { throw Error("transport unknown"); },
    })).rejects.toBeDefined();
    expect(challenges).toBeLessThanOrEqual(1);
  }
});

test("额度/配置错误只禁用对应节点，后续节点继续，后台禁用人工", async () => {
  const attempts: string[] = [];
  const service = createCaptchaService({ providers: { available: () => true, async solve(id) {
    attempts.push(id); throw new ProviderFailure("no_credit", false);
  } } });
  let manual = 0;
  const result = await service.run({ signal: new AbortController().signal, verify: async () => {}, challenge: async () => v4,
    accept: async () => ({ accepted: false }), allowManual: false, manualProof: async () => { manual++; return proof4("manual"); } });
  expect(result.ok).toBe(false); expect(attempts).toEqual(["local", "ttocr"]); expect(manual).toBe(0);
});

test("人工票据在完成、通知失败和原操作退出后均取消", async () => withCaptchaInteraction(() => true, async () => {
  let scope: AbortSignal | undefined, reads = 0;
  const service = createCaptchaService({ config: { providers: ["manual"] }, manualRelay: () => ({
    async register(_challenge, signal) { scope = signal; return { link: "https://example.invalid/manual", expiresAt: Date.now() + 1000, ticket: {} as never }; },
    async readResult() { reads++; return { status: "complete", result: proof4("manual") }; },
  }) });
  expect(await service.run({ signal: new AbortController().signal, verify: async () => {}, challenge: async () => v4,
    accept: async () => ({ accepted: true, value: true }), notify: () => true })).toEqual({ ok: true, value: true });
  expect(scope?.aborted).toBe(true); expect(reads).toBe(1);
}));

test("本地v3/v4惰性内部调用、复用识别器且不走HTTP，signed risk_type完整传入", async () => {
  const seen: unknown[] = [];
  let initialized = 0, closed = 0;
  const providers = createAutomaticProviders(captchaConfig({}), {
    fetchImpl: (async () => { throw new Error("本地节点不应发送HTTP请求"); }) as unknown as typeof fetch,
    createLocalSolver: async () => {
      initialized++;
      return {
        async solve(input, signal) {
          signal.throwIfAborted(); seen.push(input);
          return input.version === 4 ? { version: 4, ...wire4("fresh") }
            : { version: 3, challenge: "updated-sdk-challenge", validate: "validate", seccode: "validate|jordan" };
        },
        async close() { closed++; },
      };
    },
  });
  expect(initialized).toBe(0);
  expect(await providers.solve("local", v4, new AbortController().signal)).toEqual(proof4("fresh"));
  expect(await providers.solve("local", { captchaVersion: 3, gt: "gt", challenge: "original" }, new AbortController().signal))
    .toEqual({ challenge: "updated-sdk-challenge", validate: "validate", seccode: "validate|jordan" });
  expect(initialized).toBe(1);
  expect(seen).toEqual([{ version: 4, captcha_id: v4.captchaId, risk_type: v4.riskType }, { version: 3, gt: "gt", challenge: "original" }]);
  await providers.close(); expect(closed).toBe(1);
  await expect(providers.solve("local", v4, new AbortController().signal)).rejects.toMatchObject({ reason: "service_closed" });
});

test("TTOCR按388/488提交，至少2秒轮询，4039结束本题且IP禁用冷却30分钟", async () => {
  let now = 0, mode = 3, requestCount = 0, failCode = 0;
  const waits: number[] = [];
  const submitted: URLSearchParams[] = [];
  const providers = createAutomaticProviders(captchaConfig({ ttocr: { key: "private-fixture", poll_interval_ms: 1 } }), {
    now: () => now, wait: async ms => { waits.push(ms); now += ms; },
    fetchImpl: (async (url, init) => {
      requestCount++;
      const fields = new URLSearchParams(String(init?.body));
      if (String(url).endsWith("recognize")) { submitted.push(fields); return Response.json({ status: 1, resultid: `task-${mode}` }); }
      if (failCode) return Response.json({ status: failCode });
      return Response.json({ status: 1, data: mode === 4 ? wire4("ttocr-lot") : { challenge: "new-sdk", validate: "validate" } });
    }) as typeof fetch,
  });
  await providers.solve("ttocr", { captchaVersion: 3, gt: "gt", challenge: "challenge" }, new AbortController().signal);
  mode = 4;
  await providers.solve("ttocr", v4, new AbortController().signal);
  expect(submitted[0]?.get("itemid")).toBe("388"); expect(submitted[1]?.get("itemid")).toBe("488");
  expect(submitted[1]?.get("gt")).toBe(v4.captchaId); expect(submitted[1]?.get("ts_risktype")).toBe(v4.riskType);
  expect(submitted[1]?.has("challenge")).toBe(false); expect(waits).toEqual([2000, 2000]);
  failCode = 4039;
  await expect(providers.solve("ttocr", v4, new AbortController().signal)).rejects.toMatchObject({ code: 4039, retryable: true });
  failCode = 4030;
  await expect(providers.solve("ttocr", v4, new AbortController().signal)).rejects.toMatchObject({ code: 4030, retryable: false });
  const before = requestCount;
  expect(providers.available("ttocr")).toBe(false);
  await expect(providers.solve("ttocr", v4, new AbortController().signal)).rejects.toMatchObject({ retryable: false });
  expect(requestCount).toBe(before); now += 30 * 60_000; expect(providers.available("ttocr")).toBe(true);
});

test("拒绝版本混合、冲突字段及不完整证明；旧本地endpoint不再参与运行", () => {
  for (const proof of [
    { ...wire4("lot"), captchaId: "wrong" }, { ...wire4("lot"), validate: "v3" }, { ...wire4("lot"), version: 3 },
    { lot_number: "lot" }, { ...wire4("lot"), gen_time: "bad" },
  ]) expect(normalizeCaptchaProof(proof, v4)).toBeUndefined();
  const c3 = { captchaVersion: 3, gt: "gt", challenge: "c" } as const;
  expect(normalizeCaptchaProof({ validate: "v", seccode: "wrong", geetest_seccode: "v|jordan" }, c3)).toBeUndefined();
  expect(captchaConfig({ test_nine: { endpoint: "not-an-address" } }).local).toEqual({ enabled: true, timeoutMs: 120000 });
});

test("关闭人工节点时不获取人工挑战、不发布链接", async () => {
  const service = createCaptchaService({ config: { providers: ["manual"], gtmanual: { enable: false } } });
  let challenges = 0, manual = 0;
  expect((await service.run({ signal: new AbortController().signal, verify: async () => {},
    challenge: async () => { challenges++; return v4; },
    accept: async () => ({ accepted: false }),
    manualProof: async () => { manual++; return proof4("manual"); },
  })).ok).toBe(false);
  expect(challenges).toBe(0); expect(manual).toBe(0);
});
