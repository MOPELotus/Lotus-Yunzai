import { expect, test } from "bun:test";
import { CaptchaBusinessRejectedError, isCaptchaResourceBusy, createProfileHoyoClient, getDefaultCaptchaSolver, setDefaultCaptchaSolver, type CaptchaRun, type CaptchaSolver } from "@lotus-yunzai/hoyo-client";
import { submitBbsCheckin } from "../packages/hoyo-client/bbs-checkin.ts";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import { gameCheckinCommands } from "../lib/game-checkin-commands.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile: ProfileAccountContext = {
  qq: "10001", profileId: 1, revision: "fixture",
  account: { stuid: "67890", ltuid: "67890", mid: "fixture-mid", stoken: "v2_fixture-stoken", ltoken: "v2_fixture-ltoken",
    stokenCookie: "stuid=67890; stoken=v2_fixture-stoken; mid=fixture-mid",
    cookie: "ltuid_v2=67890; ltmid_v2=fixture-mid; ltoken_v2=v2_fixture-ltoken; cookie_token_v2=v2_fixture-cookie" },
  device: { id: "fixture-device", fp: "fixture-fp", name: "Fixture", model: "Fixture", androidVersion: "14", raw: {} },
};
const ok = (data: object) => Response.json({ retcode: 0, data });
const solver: CaptchaSolver = {
  async run<T>(options: CaptchaRun<T>) {
    const challenge = await options.challenge();
    if ("completed" in challenge) return { ok: true, value: challenge.completed };
    if (challenge.captchaVersion !== 3) throw new Error("fixture version");
    const result = await options.accept({ challenge: challenge.challenge, validate: "fixture-proof", seccode: "fixture-proof|jordan" }, challenge);
    return result.accepted ? { ok: true, value: result.value } : { ok: false, reason: "rejected" };
  },
};
async function scoped(run: () => Promise<void>, configured = solver) {
  const previous = getDefaultCaptchaSolver();
  setDefaultCaptchaSolver(configured);
  try { await run(); } finally { setDefaultCaptchaSolver(previous); }
}

type Failure = "create-http" | "create-shape" | "verify-http" | "verify-rejected" | "business-unknown" | "business-shape" | "business-rejected";
for (const failure of ["create-http", "create-shape", "verify-http", "verify-rejected", "business-unknown", "business-shape", "business-rejected"] as const) {
  test(`BBS ${failure} 仅在最后一次原写入已明确拒绝时报告可重新发起`, async () => scoped(async () => {
    let signs = 0;
    let error: unknown;
    try {
      await submitBbsCheckin(profile, async (url) => {
        if (url.pathname.endsWith("/signIn")) {
          signs++;
          if (signs === 1 || failure === "business-rejected") return Response.json({ retcode: 1034 });
          if (failure === "business-unknown") throw new Error("fixture dispatch lost");
          return new Response("not JSON", { headers: { "Content-Type": "application/json" } });
        }
        if (url.pathname.endsWith("/createVerification")) {
          if (failure === "create-http") return new Response(null, { status: 403 });
          if (failure === "create-shape") return ok({ gt: "fixture-gt" });
          return ok({ gt: "fixture-gt", challenge: "fixture-challenge", captcha_id: "" });
        }
        if (failure === "verify-http") return new Response(null, { status: 503 });
        if (failure === "verify-rejected") return Response.json({ retcode: -500, data: {} });
        return ok({ challenge: "fixture-business-token" });
      }, "2");
    } catch (caught) { error = caught; }
    const uncertain = failure === "business-unknown" || failure === "business-shape";
    expect(error).toBeDefined();
    if (uncertain) expect(error).not.toBeInstanceOf(CaptchaBusinessRejectedError);
    else {
      expect(error).toBeInstanceOf(CaptchaBusinessRejectedError);
      expect(error).toMatchObject({ originalRequestRejected: true, code: "api", retcode: 1034,
        stage: failure.startsWith("create") ? "challenge" : failure === "business-rejected" ? "business" : "verification" });
      expect((error as Error).message).not.toContain("fixture-");
    }
    expect(signs).toBe(failure.startsWith("business") ? 2 : 1);
  }));
}

test("没有可用识别节点时，已明确拒绝的原写不变成未知", async () => scoped(async () => {
  await expect(submitBbsCheckin(profile, async () => Response.json({ retcode: 1034 }), "2"))
    .rejects.toBeInstanceOf(CaptchaBusinessRejectedError);
}, { async run() { return { ok: false, reason: "providers_unavailable" }; } }));

test("初次拒绝的API上下文失效不变成可恢复证明，也不追加写入", async () => {
  const controller = new AbortController();
  let signs = 0;
  await scoped(async () => {
    let error: unknown;
    try {
      await submitBbsCheckin(profile, async () => { signs++; return Response.json({ retcode: 1034 }); }, "2", { signal: controller.signal });
    } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(CaptchaBusinessRejectedError);
    expect(signs).toBe(1);
  }, { async run() { controller.abort(); throw new Error("fixture interrupted"); } });
});

for (const dispatched of [false, true]) {
  test(`命令账本保存 ${dispatched ? "真正未知提交" : "已明确拒绝且造题失败"}，仅拒绝的任务允许本人重试`, async () => scoped(async () => {
    const root = await mkdtemp(join(tmpdir(), "lotus-bbs-rejected-journal-"));
    const controller = new AbortController();
    let signs = 0, recovered = false;
    try {
      await writeFile(join(root, profile.qq + ".yaml"), Bun.YAML.stringify({
        enabled: true, account: { ...profile.account, stoken_cookie: profile.account.stokenCookie },
        device: { bound: true, ...profile.device }, games: { cn: { enable: false } },
        mihoyobbs: { enable: true, tasks: { checkin: true }, checkin_list: [2] },
      }));
      const store = createCheckinScheduleStore(join(root, "plans"));
      const module = gameCheckinCommands(root, controller.signal, {
        scheduleStore: store, makeClient: (profiles, transport) => createProfileHoyoClient(profiles, transport),
        async renderReceipt() { throw new Error("fixture uses text"); },
        async transport(url) {
          if (url.pathname.endsWith("/getUserMissionsState")) return ok({ states: [], total_points: 10 });
          if (url.pathname.endsWith("/createVerification")) return dispatched ? ok({ gt: "fixture-gt", challenge: "fixture-challenge" }) : new Response(null, { status: 403 });
          if (url.pathname.endsWith("/verifyVerification")) return ok({ challenge: "fixture-business-token" });
          signs++;
          if (!recovered && signs === 1) return Response.json({ retcode: 1034 });
          if (dispatched) throw new Error("fixture original write result lost");
          return ok({ gids: 2 });
        },
      });
      const invocation = () => module.runNamed(profile.qq, { profileId: 1, target: { kind: "community", forum: "2" } }, { signal: controller.signal, verifySession: async () => {} });
      const first = await invocation();
      const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
      expect((await store.read(date))?.entries[0]?.communityWrites?.["2"]).toBe(dispatched ? "unconfirmed" : "rejected");
      expect(first).toContain(dispatched ? "未确认" : "原社区请求未被受理");
      const previousSigns = signs;
      recovered = true;
      await invocation();
      expect(signs).toBe(dispatched ? previousSigns : previousSigns + 1);
      expect((await store.read(date))?.entries[0]?.communityWrites?.["2"]).toBe(dispatched ? "unconfirmed" : "accepted");
    } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
  }));
}


test("local resource exhaustion preserves explicit rejection proof without reporting bad captcha answers", async () => scoped(async () => {
  let writes = 0;
  let caught: unknown;
  try { await submitBbsCheckin(profile, async () => { writes++; return Response.json({ retcode: 1034 }); }, "2"); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CaptchaBusinessRejectedError);
  expect(isCaptchaResourceBusy(caught)).toBe(true);
  expect(writes).toBe(1);
}, { async run() { return { ok: false, reason: "local_busy" }; } }));
