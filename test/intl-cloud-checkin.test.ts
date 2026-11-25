import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { checkinScheduleClock } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleRuntime } from "../lib/checkin-schedule-runtime.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { gameCheckinCommands } from "../lib/game-checkin-commands.ts";
import { stageLegacyProfiles } from "../lib/migration-profiles.ts";

const globalCloud = "https://sg-cg-api.hoyoverse.com/hk4e_global/cg/wallet/wallet/get";
const domesticCloud = "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/wallet/wallet/get";
const globalToken = "ai=9;ci=1;oi=fixture;ct=opaque;si=fixture;bi=hk4e_global";
const domesticToken = "fixture-domestic-token";
const qq = "42";
const profileId = 2;

function fixtureProfile({ enable, token, language, uid = "123", domesticEnabled, domesticCredential = domesticToken }: {
  enable?: boolean; token?: string; language?: string; uid?: string; domesticEnabled?: boolean; domesticCredential?: string;
} = {}) {
  return Bun.YAML.stringify({ enabled: true, user: { qq }, profile: { id: profileId },
    games: { cn: { enable: false }, os: { enable: false, cookie: "ltuid=943;cookie_token=other-realm-fixture" } },
    account: { stuid: uid, ltuid: uid, cookie: `account_id=${uid};cookie_token=domestic-fixture`, stoken: "fixture-main-stoken" },
    device: { id: "fixture-device-id", fp: "fixture-fp", model: "Fixture Model", android_version: "13", bound: true },
    cloud_games: { cn: { enable: domesticEnabled, genshin: { enable: true, token: domesticCredential } },
      os: { enable, lang: language, genshin: { enable: true, token: token ?? globalToken } } },
  });
}

test("迁入的旧国际服云钱包由本人手动和正常定时使用，子范围补跑跳过，凭据按地区隔离", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-intl-cloud-checkin-"));
  const raw = join(root, "legacy");
  const staged = join(root, "staged");
  const legacyProfiles = join(raw, "plugins/Lotus-Plugin/data/users");
  const profileDirectory = join(staged, "data/users");
  const file = join(profileDirectory, `${qq}-${profileId}.yaml`);
  const initial = fixtureProfile({ language: "en-us" });
  const calls: string[] = [];
  let response = { free_time: "0", send_freetime: 15 };
  let expectedLanguage = "en-us";
  let expired = false;
  let rebind = false;
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const international = url.pathname.includes("hk4e_global");
    expect(request.headers.get("x-rpc-combo_token")).toBe(international ? globalToken : domesticToken);
    expect(request.method).toBe("GET");
    for (const header of ["Cookie", "Authorization", "x-rpc-device_fp", "x-rpc-challenge"]) expect(request.headers.has(header)).toBe(false);
    if (international) {
      expect(request.headers.get("x-rpc-client_type")).toBe("3");
      expect(request.headers.get("x-rpc-cg_game_biz")).toBe("hk4e_global");
      expect(request.headers.get("x-rpc-channel_id")).toBe("1");
      expect(request.headers.get("x-rpc-device_id")).toBe("fixture-device-id");
      expect(request.headers.get("x-rpc-language")).toBe(expectedLanguage);
      expect(request.headers.get("Referer")).toBe("https://app.mihoyo.com");
      const [t, r, hash] = request.headers.get("DS")!.split(",");
      expect(hash).toBe(createHash("md5").update(`salt=okr4obncj8bw5a65hbnn5oo6ixjc3l9w&t=${t}&r=${r}`).digest("hex"));
      if (rebind) await writeFile(file, fixtureProfile({ uid: "987" }));
      if (expired) return Response.json({ retcode: -100, data: null });
    } else expect(request.headers.get("x-rpc-client_type")).toBe("19");
    return Response.json({ retcode: 0, data: { free_time: international ? response : { free_time: 200, send_freetime: "0" } } });
  } });
  const controller = new AbortController();
  const store = createCheckinScheduleStore(join(staged, "data/schedules"));
  const module = gameCheckinCommands(profileDirectory, controller.signal, {
    scheduleStore: store,
    async renderReceipt() { throw new Error("用文字验收"); },
    async transport(url, init) {
      expect([globalCloud, domesticCloud]).toContain(url.href);
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      calls.push(url.href);
      const result = await fetch(new URL(url.pathname, gateway.url), init);
      return new Response(result.body, { status: result.status, headers: result.headers });
    },
  });
  const { date } = checkinScheduleClock();
  const receipt: unknown[] = [];
  const runtime = createCheckinScheduleRuntime({
    store, signal: controller.signal, config: { mode: "fixed", fixed_time: "18:00" },
    now: () => Date.parse(`${date}T18:45:00+08:00`),
    listProfiles: createProfileStore(profileDirectory).listCheckinProfiles,
    runProfile: (entry, context) => module.runScheduled(entry.qq, entry.profileId, context),
    onComplete(_entry, result) { receipt.push(result.reply); },
  });
  const web = () => module.runWeb(qq, profileId, { signal: controller.signal, async verifySession() {} });
  try {
    await mkdir(legacyProfiles, { recursive: true });
    await mkdir(staged);
    const old = join(legacyProfiles, `${qq}-${profileId}.yaml`);
    await writeFile(old, initial);
    expect(await stageLegacyProfiles(raw, staged)).toMatchObject({ imported: 1 });
    expect(await readFile(file, "utf8")).toBe(initial);
    const result = await web();
    expect(result.status).toBe("completed");
    expect(result.message).toContain("云原神国际服剩余免费时长：0 分钟，本次赠送：15 分钟");
    expect(result.message).toContain("云原神剩余免费时长：200 分钟，本次赠送：0 分钟");
    expect(result.message).not.toMatch(/opaque|fixture|token/u);
    expect(calls.splice(0)).toEqual([domesticCloud, globalCloud]);
    const progress: unknown[] = [];
    const chat = await module.fallback!("#手动签到2", {
      normalizedMessage: "#手动签到2", message_type: "private", user_id: 42, reply: message => {
        progress.push([message, [...calls]]);
        return true;
      },
      isBotMaster: () => false, isMaster: false, privateCredentialSignal: controller.signal,
    });
    expect(progress).toEqual([["开始执行档案 2 签到。", []]]);
    expect(chat).toContain("云原神国际服剩余免费时长：0 分钟，本次赠送：15 分钟");
    expect(calls.splice(0)).toEqual([domesticCloud, globalCloud]);
    const missing = await module.fallback!("#手动签到3", {
      normalizedMessage: "#手动签到3", message_type: "private", user_id: 42, reply: message => { progress.push(message); return true; },
      isBotMaster: () => false, isMaster: false, privateCredentialSignal: controller.signal,
    });
    expect(missing).toContain("请先登录档案 3");
    expect(progress).toHaveLength(1);
    response = { free_time: "18", send_freetime: 0 };
    expect(await runtime.runDue()).toMatchObject({ completed: 1 });
    expect(receipt).toHaveLength(1);
    expect(String(receipt[0])).toContain("云原神国际服剩余免费时长：18 分钟，本次赠送：0 分钟");
    expect(await runtime.runDue()).toMatchObject({ completed: 0 });
    expect(calls.splice(0)).toEqual([domesticCloud, globalCloud]);
    await module.runScheduled(qq, profileId, { date, signal: controller.signal, verifyDay() {}, communityRetryForums: [] });
    expect(calls).toEqual([]);
    expect((await store.read(date))?.entries[0]).toMatchObject({ done: true, ok: true });
    await writeFile(file, fixtureProfile({ enable: false }));
    expect((await web()).message).not.toContain("云原神国际服");
    expect(calls.splice(0)).toEqual([domesticCloud]);
    await writeFile(file, fixtureProfile({ enable: false, domesticEnabled: false }));
    const disabled = await web();
    expect(disabled.status).toBe("completed");
    expect(disabled.message).not.toContain("云原神");
    expect(calls).toEqual([]);
    await writeFile(file, fixtureProfile({ enable: false, domesticCredential: " " }));
    expect(await web()).toMatchObject({ status: "failed", message: expect.stringContaining("请先在私聊绑定云原神凭据。") });
    expect(calls).toEqual([]);
    await writeFile(file, fixtureProfile({ token: globalToken.replace("hk4e_global", "hk4e_cn") }));
    expect(await web()).toMatchObject({ status: "failed" });
    expect(calls.splice(0)).toEqual([domesticCloud]);
    expectedLanguage = "zh-cn";
    await writeFile(file, fixtureProfile());
    expired = true;
    expect(await web()).toMatchObject({
      status: "failed", message: expect.stringContaining("云原神国际服凭据已失效"),
    });
    expect(calls.splice(0)).toEqual([domesticCloud, globalCloud]);
    expired = false;
    rebind = true;
    expect(await web()).toMatchObject({ status: "busy", message: expect.stringContaining("档案") });
    expect(calls.splice(0)).toEqual([domesticCloud, globalCloud]);
    expect(await readFile(old, "utf8")).toBe(initial);
  } finally {
    controller.abort();
    await runtime.stop();
    await gateway.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
