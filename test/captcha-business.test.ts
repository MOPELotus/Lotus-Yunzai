import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileAccountContext, ProfileRequestContext } from "../packages/account/index.ts";
import { getDefaultCaptchaSolver, setDefaultCaptchaSolver, type CaptchaChallenge, type CaptchaRun, type CaptchaSolver } from "../packages/hoyo-client/captcha.ts";
import { withMiyousheCaptcha } from "../packages/hoyo-client/captcha-business.ts";
import { submitBbsCheckin } from "../packages/hoyo-client/bbs-checkin.ts";
import { GameRecordRequestError } from "../packages/hoyo-client/game-record.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { openHoYoLabGenshinCheckin } from "../packages/hoyo-client/hoyolab-genshin-checkin.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";

const source: ProfileRequestContext = {
  qq: "42", profileId: 2, revision: "fixture-revision", game: "sr",
  role: { uid: "123456789", region: "prod_gf_cn", gameBiz: "hkrpg_cn", chosen: true, nickname: "Fixture" },
  account: { stuid: "67890", ltuid: "67890", mid: "", ltoken: "fixture-ltoken", stoken: "fixture-stoken", stokenCookie: "stuid=67890; stoken=fixture-stoken", cookie: "ltoken=fixture-ltoken; ltuid=67890" },
  device: { id: "fixture-device", fp: "123456789abcd", name: "Fixture", model: "Fixture", androidVersion: "14", raw: {} },
};
const ok = (data: unknown, headers?: HeadersInit) => Response.json({ retcode: 0, data }, { headers });
const risk = () => Response.json({ retcode: 1034, data: {} }, { headers: { "x-trace-id": "original-response-trace" } });
const proof = (challenge: CaptchaChallenge) => {
  if (challenge.captchaVersion !== 3) throw new Error("expected v3");
  return { challenge: challenge.challenge, validate: "fixture-proof-" + challenge.challenge, seccode: "fixture-proof-" + challenge.challenge + "|jordan" };
};
function solver(attempts = 1, beforeAccept?: (options: CaptchaRun<unknown>) => Promise<void>): CaptchaSolver {
  return {
    async run<T>(options: CaptchaRun<T>) {
      for (let index = 0; index < attempts; index++) {
        await options.verify();
        const challenge = await options.challenge();
        if ("completed" in challenge) return { ok: true, value: challenge.completed };
        await beforeAccept?.(options);
        const accepted = await options.accept(proof(challenge), challenge);
        if (accepted.accepted) return { ok: true, value: accepted.value };
      }
      return { ok: false, reason: "rejected" };
    },
  };
}

async function scoped(run: () => Promise<void>, configured: CaptchaSolver = solver()) {
  const previous = getDefaultCaptchaSolver();
  setDefaultCaptchaSolver(configured);
  try { await run(); } finally { setDefaultCaptchaSolver(previous); }
}

test("默认 client 体力风控经同档案 record create/verify 续读，保留路径、原 trace、设备和 DS2", async () => scoped(async () => {
  const requests: string[] = [];
  const client = createHoyoClient(async (url, init) => {
    requests.push(url.pathname);
    const headers = new Headers(init.headers);
    if (url.pathname.endsWith("/createVerification") || url.pathname.endsWith("/verifyVerification")) {
      expect(url.origin).toBe("https://api-takumi-record.mihoyo.com");
      expect(headers.get("x-rpc-challenge_path")).toBe("/hkrpg/api/note");
      expect(headers.get("x-rpc-challenge_trace")).toBe("original-response-trace");
      expect(headers.get("x-rpc-challenge_game")).toBe("6");
      expect(headers.get("x-rpc-device_id")).toBe(source.device.id!);
      expect(headers.get("x-rpc-device_fp")).toBe(source.device.fp!);
      expect(headers.get("Cookie")).toBe(source.account.cookie);
      const [time, nonce, hash] = headers.get("DS")!.split(",");
      expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${time}&r=${nonce}&b=${init.body ?? ""}&q=${url.search.slice(1)}`).digest("hex"));
      if (url.pathname.endsWith("/createVerification")) return ok({ gt: "fixture-gt", challenge: "fresh-challenge" });
      expect(JSON.parse(String(init.body))).toEqual({ geetest_challenge: "fresh-challenge", geetest_validate: "fixture-proof-fresh-challenge", geetest_seccode: "fixture-proof-fresh-challenge|jordan" });
      return ok({ challenge: "accepted-business-token" });
    }
    expect(url.pathname).toBe("/game_record/app/hkrpg/api/note");
    if (!headers.has("x-rpc-challenge")) return risk();
    expect(headers.get("x-rpc-challenge")).toBe("accepted-business-token");
    return ok({ current_stamina: 50, max_stamina: 300 });
  });
  const [result] = await client.fetchDailyNotes([source]);
  expect(result?.status).toBe("fulfilled");
  if (result?.status === "fulfilled") expect(result.value.stamina).toEqual({ current: 50, max: 300 });
  expect(requests).toHaveLength(4);
}));

test("record 业务拒绝后的尝试刷新挑战，tool 使用对应 app_key，失败不续交原业务", async () => scoped(async () => {
  let created = 0, verified = 0, reads = 0;
  const client = createHoyoClient(async (url, init) => {
    const headers = new Headers(init.headers);
    if (url.pathname.endsWith("/createGeetest")) {
      expect(url.origin).toBe("https://api-takumi.mihoyo.com");
      expect(url.searchParams.get("app_key")).toBe("hkrpg_game_record");
      return ok({ gt: "fixture-gt", challenge: `fresh-${++created}` });
    }
    if (url.pathname.endsWith("/verifyGeetest")) {
      verified++;
      const body = JSON.parse(String(init.body));
      expect(body.app_key).toBe("hkrpg_game_record");
      expect(body.geetest_challenge).toBe(`fresh-${verified}`);
      return verified === 1 ? Response.json({ retcode: -500, data: {} }) : ok({ challenge: "accepted" });
    }
    reads++;
    return headers.has("x-rpc-challenge") ? ok({ current_stamina: 1, max_stamina: 300 }) : Response.json({ retcode: 10035 });
  });
  const [result] = await client.fetchDailyNotes([source]);
  expect(result?.status).toBe("fulfilled");
  expect([created, verified, reads]).toEqual([2, 2, 2]);
}, solver(2)));

test("10041、认证失败夹带旧挑战、429、网络故障及未知路由均不创建验证码", async () => {
  for (const response of [Response.json({ retcode: 10041 }), Response.json({ retcode: -100, data: { is_risk: true, gt: "old", challenge: "old" } }), Response.json({ retcode: 1034 }, { status: 429 })]) {
    let solves = 0, requests = 0;
    await scoped(async () => {
      const client = createHoyoClient(async () => { requests++; return response; });
      const [result] = await client.fetchDailyNotes([source]);
      expect(result?.status).toBe("rejected");
      expect(solves).toBe(0);
      expect(requests).toBe(1);
    }, { async run() { solves++; return { ok: false, reason: "unexpected" }; } });
  }
  await scoped(async () => {
    let requests = 0;
    await expect(withMiyousheCaptcha(async () => { requests++; return risk(); }, async request => {
      await request(new URL("https://unregistered.invalid/game_record/app/hkrpg/api/note"), {});
      throw new GameRecordRequestError("fixture", "risk", "api", 200, 1034);
    }, { game: "sr" })).rejects.toMatchObject({ reason: "risk" });
    expect(requests).toBe(1);
  }, { async run() { throw new Error("unregistered endpoint must not solve"); } });
});

test("BBS 显式拒绝后用同账号 STOKEN 走 misc，原分区请求体保持原样", async () => scoped(async () => {
  const profile: ProfileAccountContext = { ...source, account: { ...source.account, stokenCookie: "stuid=67890; stoken=fixture-stoken" } };
  let submissions = 0;
  const transport: HoyoTransport = async (url, init) => {
    const headers = new Headers(init.headers);
    if (url.pathname.startsWith("/misc/")) {
      expect(headers.get("Cookie")).toContain("stoken=fixture-stoken");
      const [time, nonce, hash] = headers.get("DS")!.split(",");
      expect(hash).toBe(createHash("md5").update(`salt=9c7b896d7483e9070b27c55f1959c4d5&t=${time}&r=${nonce}`).digest("hex"));
      return url.pathname.endsWith("createVerification") ? ok({ gt: "fixture-gt", challenge: "fresh" }) : ok({ challenge: "bbs-accepted" });
    }
    submissions++;
    expect(init.body).toBe('{"gids":"6"}');
    return headers.get("x-rpc-challenge") === "bbs-accepted" ? ok({ gids: "6" }) : risk();
  };
  expect(await submitBbsCheckin(profile, transport, "6")).toBe("accepted");
  expect(submissions).toBe(2);
}));

test("国际服内嵌 v3 保持原活动、Cookie、device，证明回填后仍由原业务解析确认", async () => scoped(async () => {
  const account = { cookie: "account_id=4201; cookie_token=fixture-token", realm: "EU" as const, accountId: "4201", language: "en-us" };
  let writes = 0;
  const reader = await openHoYoLabGenshinCheckin(account, async (url, init) => {
    if (url.hostname === "api-account-os.hoyolab.com") return ok({ list: [{ game_uid: "700000001", region: "os_euro", game_biz: "hk4e_global", is_chosen: true }] });
    if (url.pathname.endsWith("/info")) return ok({ is_sign: false, first_bind: false });
    expect(url.pathname).toBe("/event/sol/sign");
    writes++;
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe(account.cookie);
    expect(headers.get("x-rpc-device_id")).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(init.body).toBe('{"act_id":"e202102251931481"}');
    return writes === 1 ? ok({ gt_result: { is_risk: true, gt: "fixture-gt", challenge: "inline-fresh" } }) : ok({ gt_result: { is_risk: false } });
  }, { verifyProfile: async () => {}, deviceId: "550e8400-e29b-41d4-a716-446655440000", captchaContext: { qq: "42", profileId: 2 } });
  await reader.readInfo();
  expect(await reader.submit({ blockedUids: [] })).toBe("accepted");
  expect(writes).toBe(2);
}));

test("识别等待超过旧 HTTP deadline，原业务续交取得新 deadline", async () => {
  let oldSignal: AbortSignal | null | undefined;
  await scoped(async () => {
    let attempts = 0;
    const url = new URL("https://sg-act-public-api.hoyolab.com/event/sol/sign");
    const value = await withMiyousheCaptcha(async (_url, init) => {
      attempts++;
      expect(init.signal?.aborted).toBe(false);
      if (attempts === 1) oldSignal = init.signal;
      else {
        expect(oldSignal?.aborted).toBe(true);
        expect(init.signal).not.toBe(oldSignal);
        expect(new Headers(init.headers).get("x-rpc-validate")).toBe("fixture-proof-initial");
      }
      return attempts === 1 ? ok({ gt_result: { is_risk: true, gt: "fixture-gt", challenge: "initial" } }) : ok({ result: "accepted" });
    }, async request => {
      const response = await request(url, { method: "POST", signal: AbortSignal.timeout(10) });
      const payload = await response.json();
      if (payload.data.gt_result?.is_risk) throw new GameRecordRequestError("fixture", "risk", "api", 200);
      return payload.data.result;
    });
    expect(value).toBe("accepted");
    expect(attempts).toBe(2);
  }, solver(1, async options => {
    await Bun.sleep(20);
    expect(options.signal.aborted).toBe(false);
  }));
});

test("识别期间取消或换档阻止续交，未知提交结果也不进入识别", async () => {
  for (const mode of ["cancel", "changed"] as const) {
    const lifetime = new AbortController();
    let changed = false, writes = 0;
    await scoped(async () => {
      await expect(withMiyousheCaptcha(async () => {
        writes++;
        return ok({ gt_result: { is_risk: true, gt: "fixture-gt", challenge: "initial" } });
      }, async request => {
        await request(new URL("https://sg-act-public-api.hoyolab.com/event/sol/sign"), { method: "POST" });
        throw new GameRecordRequestError("fixture", "risk", "api", 200);
      }, { signal: lifetime.signal, verify: async () => { if (changed) throw new Error("profile changed"); } })).rejects.toThrow();
      expect(writes).toBe(1);
    }, solver(1, async () => { if (mode === "cancel") lifetime.abort(); else changed = true; }));
  }
  await scoped(async () => {
    let writes = 0;
    await expect(submitBbsCheckin(source, async () => { writes++; throw new Error("connection closed after dispatch"); }, "6")).rejects.toMatchObject({ code: "transport" });
    expect(writes).toBe(1);
  }, { async run() { throw new Error("unknown write must not solve"); } });
});

test("风控响应声明了其它账号或角色时不消费识别额度", async () => scoped(async () => {
  const client = createHoyoClient(async () => Response.json({ retcode: 1034, data: { uid: "999999999" } }));
  const [result] = await client.fetchDailyNotes([source]);
  expect(result?.status).toBe("rejected");
  if (result?.status === "rejected") expect(result.reason.code).toBe("response");
  await expect(submitBbsCheckin(source, async () => Response.json({ retcode: 1034, data: { uid: "123" } }), "6")).rejects.toMatchObject({ code: "response" });
}, { async run() { throw new Error("mismatched identity must not solve"); } }));

test("恢复多步读取时复用此前成功响应，不重发已成功的 POST，也不改变正常重复读取", async () => scoped(async () => {
  const initial = new URL("https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/character/list");
  const failed = new URL("https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/index?role_id=123456789&server=cn_gf01");
  let priorWrites = 0, reads = 0;
  const result = await withMiyousheCaptcha(async (url, init) => {
    if (url.pathname.endsWith("/createVerification")) return ok({ gt: "fixture-gt", challenge: "fresh" });
    if (url.pathname.endsWith("/verifyVerification")) return ok({ challenge: "accepted" });
    if (url.href === initial.href) { priorWrites++; return ok({ list: [1] }); }
    reads++;
    return new Headers(init.headers).has("x-rpc-challenge") ? ok({ value: 2 }) : risk();
  }, async request => {
    const previous = await request(initial, { method: "POST", body: '{"role_id":"123456789"}' });
    const catalogue = await previous.json();
    expect(catalogue.data.list).toEqual([1]);
    const response = await request(failed, { method: "GET" });
    const payload = await response.json();
    if (payload.retcode === 1034) throw new GameRecordRequestError("fixture", "risk", "api", 200, 1034);
    return payload.data.value;
  }, { game: "gs" });
  expect(result).toBe(2);
  expect([priorWrites, reads]).toEqual([1, 2]);
  let normalReads = 0;
  await withMiyousheCaptcha(async () => { normalReads++; return ok({}); }, async request => {
    await request(failed, {});
    await request(failed, {});
  }, { game: "gs" });
  expect(normalReads).toBe(2);
}));

test("较大的正常战绩响应保留原读取能力，限频回执不触发识别", async () => scoped(async () => {
  const url = new URL("https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/index?role_id=123456789&server=cn_gf01");
  const value = "a".repeat(600_000);
  const result = await withMiyousheCaptcha(async () => Response.json({ retcode: 0, data: { value } }, {
    headers: { "Content-Length": "600100" },
  }), async request => (await (await request(url, {})).json()).data.value, { game: "gs" });
  expect(result).toBe(value);
  await expect(withMiyousheCaptcha(async () => Response.json({ retcode: 1034, message: "请求过于频繁" }), async request => {
    await request(url, {});
    throw new GameRecordRequestError("fixture", "risk", "api", 200, 1034);
  }, { game: "gs" })).rejects.toMatchObject({ reason: "risk" });
}, { async run() { throw new Error("must not solve"); } }));
