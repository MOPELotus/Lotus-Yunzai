import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileHoyoClient, getDefaultCaptchaSolver, setDefaultCaptchaSolver, type CaptchaSolver, type CaptchaRun } from "@lotus-yunzai/hoyo-client";
import { gameCheckinCommands } from "../lib/game-checkin-commands.ts";

const qq = "10001";
const role = { uid: "100000015", region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true, nickname: "Fixture" };
const ok = (data: object) => Response.json({ retcode: 0, data });
const challenge = () => ok({ is_risk: true, gt: "fixture-gt", challenge: "fixture-challenge" });

const finiteSolver: CaptchaSolver = {
  async run<T>(options: CaptchaRun<T>) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await options.verify();
      const input = await options.challenge();
      if ("completed" in input) return { ok: true, value: input.completed };
      if (input.captchaVersion !== 3) return { ok: false, reason: "unexpected_version" };
      const accepted = await options.accept({ challenge: input.challenge, validate: "fixture-proof", seccode: "fixture-proof|jordan" }, input);
      if (accepted.accepted) return { ok: true, value: accepted.value };
    }
    return { ok: false, reason: "rejected" };
  },
};

type Mode = "unsigned" | "risk-read" | "risk-then-unsigned" | "transport-read" | "rejected-proof" | "mixed-community" | "partial-community";
async function run(mode: Mode, preparation?: "changed" | "abort" | "throw") {
  const root = await mkdtemp(join(tmpdir(), "lotus-captcha-confirmation-"));
  const controller = new AbortController();
  const previous = getDefaultCaptchaSolver();
  setDefaultCaptchaSolver(finiteSolver);
  let signs = 0, infos = 0, missions = 0, community = 0, prepared = 0;
  const settled: string[] = [];
  const gameEnabled = mode !== "partial-community";
  const communityEnabled = mode === "mixed-community" || mode === "partial-community";
  try {
    await writeFile(join(root, `${qq}.yaml`), Bun.YAML.stringify({
      enabled: true, user: { qq }, profile: { id: 1 },
      account: { stuid: "67890", ltuid: "67890", mid: "fixture-mid", stoken: "v2_fixture-stoken",
        cookie: "ltuid_v2=67890; ltmid_v2=fixture-mid; ltoken_v2=v2_fixture-ltoken; cookie_token_v2=v2_fixture-cookie" },
      device: { bound: true, id: "fixture-device", fp: "fixture-fp" },
      games: { cn: { enable: true, genshin: { checkin: gameEnabled }, honkai_sr: { checkin: false }, zzz: { checkin: false } } },
      mihoyobbs: { enable: communityEnabled, tasks: { checkin: true }, checkin_list: mode === "partial-community" ? [6, 8] : [6] },
    }));
    const module = gameCheckinCommands(root, controller.signal, {
      prepareDevice: preparation ? async (owner, id) => {
        expect([owner, id]).toEqual([qq, 1]);
        prepared++;
        if (preparation === "abort") { controller.abort(); return; }
        if (preparation === "throw") throw new Error("fixture preparation failed");
        const file = join(root, `${qq}.yaml`);
        const profile = Bun.YAML.parse(await readFile(file, "utf8")) as { device: { fp: string } };
        profile.device.fp = "fixture-issued-fp";
        await writeFile(file, Bun.YAML.stringify(profile));
      } : undefined,
      makeClient: (profiles, transport) => ({ ...createProfileHoyoClient(profiles, transport),
        refreshCredentials: async account => account, fetchCheckinRoles: async () => [role],
      }),
      async renderReceipt() { throw new Error("fixture uses text"); },
      async transport(url, init) {
        if (preparation === "changed") expect(new Headers(init.headers).get("x-rpc-device_fp")).toBe("fixture-issued-fp");
        if (url.pathname.endsWith("/info")) {
          infos++;
          if (mode === "mixed-community") return ok({ is_sign: false, first_bind: true });
          if ((infos >= 3 && mode === "risk-read") || (infos === 3 && mode === "risk-then-unsigned")) return Response.json({ retcode: 10035 });
          if (infos >= 3 && mode === "transport-read") throw new Error("fixture read interrupted");
          return ok({ is_sign: (mode === "rejected-proof" && signs >= 3) || (mode === "risk-then-unsigned" && infos >= 5), first_bind: false });
        }
        if (url.pathname.endsWith("/sign")) {
          signs++;
          if (signs === 1) return challenge();
          if (mode === "rejected-proof" && signs === 2) return Response.json({ retcode: 1034 });
          return ok({});
        }
        if (url.pathname.endsWith("/getUserMissionsState")) {
          missions++;
          return ok({ states: [], total_points: missions === 1 ? 100 : 110, already_received_points: missions === 1 ? 0 : 10 });
        }
        if (url.pathname.endsWith("/signIn")) {
          community++;
          const { gids } = JSON.parse(String(init.body));
          return gids === "8" ? Response.json({ retcode: -900, message: "fixture rejected" }) : ok({ gids });
        }
        throw new Error("unexpected fixture route: " + url.pathname);
      },
    });
    const result = await module.runScheduled(qq, 1, {
      date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }), signal: controller.signal, verifyDay() {},
      gameWrites: { previous: {}, unknown: false, async start() {}, async settle(_target, status) { settled.push(status); } },
    });
    return { result, signs, infos, missions, community, settled, prepared };
  } finally {
    setDefaultCaptchaSolver(previous);
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ["unsigned", "risk-read", "risk-then-unsigned", "transport-read"] as const) {
  test(`proof POST 已受理但状态回读 ${mode}，保留 unconfirmed 且不再提交`, async () => {
    const result = await run(mode);
    expect(result.signs).toBe(2);
    expect(result.settled).toEqual(["unconfirmed"]);
    expect(result.result).toMatchObject({ status: "complete", ok: false });
  });
}

test("只有 proof POST 本身明确风控拒绝才允许下一次新挑战", async () => {
  const result = await run("rejected-proof");
  expect(result.signs).toBe(3);
  expect(result.settled).toEqual(["confirmed"]);
  expect(result.result).toMatchObject({ status: "complete", ok: true });
});

for (const mode of ["mixed-community", "partial-community"] as const) {
  test(`社区已受理后 ${mode} 的其它失败不会省略最终任务回读`, async () => {
    const result = await run(mode);
    expect(result.missions).toBe(2);
    expect(result.community).toBe(mode === "partial-community" ? 2 : 1);
    expect(result.result).toMatchObject({ status: "complete", ok: false });
    if (result.result.status === "complete") expect(result.result.reply).toContain("当前余额：110");
  });
}


test("设备 FP 准备落盘后才捕获签到 revision，正常设备更新不会误报换档", async () => {
  const result = await run("rejected-proof", "changed");
  expect(result.prepared).toBe(1);
  expect(result.result).toMatchObject({ status: "complete", ok: true });
  expect(result.settled).toEqual(["confirmed"]);
});

for (const preparation of ["abort", "throw"] as const) {
  test(`设备准备 ${preparation} 后不读取业务或提交签到`, async () => {
    const result = await run("unsigned", preparation);
    expect(result.prepared).toBe(1);
    expect([result.signs, result.infos, result.community, result.missions]).toEqual([0, 0, 0, 0]);
    expect(result.result.status).toBe(preparation === "abort" ? "busy" : "complete");
  });
}
