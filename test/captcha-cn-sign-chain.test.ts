import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gameCheckinCommands } from "../lib/game-checkin-commands.ts";
import { createProfileHoyoClient } from "../packages/hoyo-client/index.ts";
import { setDefaultCaptchaSolver } from "../packages/hoyo-client/captcha.ts";

test("网页签到将内嵌挑战交给统一链，旧证明被拒后重新签到取新题并回读确认", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-cn-captcha-chain-"));
  let unsignedRequests = 0, proofRequests = 0, signed = false;
  const challenges: string[] = [];
  setDefaultCaptchaSolver({ async run(options) {
    for (let index = 0; index < 2; index++) {
      const challenge = await options.challenge();
      if ("completed" in challenge) return { ok: true, value: challenge.completed };
      if (challenge.captchaVersion !== 3) throw Error("unexpected v4");
      challenges.push(challenge.challenge);
      const result = await options.accept({ challenge: challenge.challenge, validate: `proof-${index}`, seccode: `proof-${index}|jordan` }, challenge);
      if (result.accepted) return { ok: true, value: result.value };
    }
    return { ok: false, reason: "rejected" };
  } });
  try {
    await writeFile(join(root, "42.yaml"), Bun.YAML.stringify({
      account: { stuid: "81526", ltuid: "81526", mid: "fixture", stoken: "v2_fixture-login",
        cookie: "ltuid_v2=81526; ltmid_v2=fixture; ltoken_v2=v2_fixture; cookie_token_v2=v2_fixture-cookie" },
      device: { id: "fixture-device", fp: "fixture-fp", bound: true },
      games: { cn: { enable: true, genshin: { checkin: true }, honkai_sr: { checkin: false }, zzz: { checkin: false } } },
      mihoyobbs: { enable: false },
    }));
    const module = gameCheckinCommands(root, new AbortController().signal, {
      scheduleStore: createCheckinScheduleStore(join(root, "plans")),
      makeClient: (profiles, transport) => ({ ...createProfileHoyoClient(profiles, transport), refreshCredentials: async account => account }),
      async transport(url, init) {
        if (url.pathname.endsWith("getUserGameRolesByCookie")) return Response.json({ retcode: 0, data: {
          list: [{ game_biz: "hk4e_cn", game_uid: "100000031", region: "cn_gf01" }] } });
        if (url.pathname.endsWith("/info")) return Response.json({ retcode: 0, data: { is_sign: signed, first_bind: false } });
        if (url.pathname.endsWith("/sign")) {
          if (new Headers(init.headers).has("x-rpc-validate")) {
            proofRequests++;
            if (proofRequests === 1) return Response.json({ retcode: 1034 });
            signed = true;
            return Response.json({ retcode: 0, data: {} });
          }
          unsignedRequests++;
          return Response.json({ retcode: 0, data: { is_risk: true, gt: "fixture-gt", challenge: `fresh-${unsignedRequests}` } });
        }
        throw Error(`unexpected ${url.pathname}`);
      },
    });
    const result = await module.runWeb("42", 1, { signal: new AbortController().signal, verifySession: async () => {}, notify: () => true });

    expect(result.status).toBe("completed");
    expect(challenges).toEqual(["fresh-1", "fresh-2"]);
    expect(proofRequests).toBe(2);
    expect(signed).toBe(true);
  } finally { setDefaultCaptchaSolver(undefined); await rm(root, { recursive: true, force: true }); }
});
