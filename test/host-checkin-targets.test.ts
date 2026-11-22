import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkinScheduleClock, generateCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const digest = (parts: readonly unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

test("单游戏和单分区在实际两协议共享同档回执，保留其它排期", async () => {
  const uid = "100000042";
  const accountId = "81526";
  const key = digest(["42", 2, accountId]);
  const genshin = "genshin:cn:" + digest(["cn_gf01", uid]);
  const otherGame = "honkai_sr:cn:" + digest(["prod_gf_cn", "100000043"]);
  const requests: string[] = [];
  let queriedRoles = 0;
  let signed = false;
  const roleReadStarted = Promise.withResolvers<void>();
  const releaseRoleRead = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const origin = request.headers.get("x-fixture-origin");
      const ok = (data: object) => Response.json({ retcode: 0, data });
      if (path === "/account/ma-cn-session/app/exchange" && origin === "passport-api.mihoyo.com") {
        const body = await request.json() as { dst_token_type: number; src_token: { token: string }; mid: string };
        expect(body.src_token.token).toBe("v2_fixture-login");
        requests.push("login:" + body.dst_token_type);
        return ok({ user_info: { aid: accountId, mid: "fixture-mid" }, token: { token: "v2_fixture-token-" + body.dst_token_type } });
      }
      if (path === "/binding/api/getUserGameRolesByCookie") {
        requests.push("roles:" + url.searchParams.get("game_biz"));
        expect(request.headers.get("cookie")).toContain("account_id_v2=" + accountId);
        if (url.searchParams.get("game_biz") === "nap_cn") {
          roleReadStarted.resolve();
          await releaseRoleRead.promise;
          return ok({ list: [{ game_biz: "nap_cn", game_uid: "12345678", region: "prod_gf_cn" }] });
        }
        expect(url.searchParams.get("game_biz")).toBe("hk4e_cn");
        if (++queriedRoles === 1) return new Response(null, { status: 410 });
        return ok({ list: [{ game_biz: "hk4e_cn", game_uid: uid, region: "cn_gf01" }] });
      }
      if (path === "/event/luna/info") {
        requests.push("status:genshin");
        expect(url.searchParams.get("uid")).toBe(uid);
        return ok({ is_sign: signed, first_bind: false });
      }
      if (path === "/event/luna/sign" && request.method === "POST") {
        const body = await request.json() as { uid: string; region: string };
        expect(body).toMatchObject({ uid, region: "cn_gf01" });
        requests.push("write:genshin");
        return new Response(null, { status: 503 });
      }
      if (path === "/apihub/wapi/getUserMissionsState") {
        requests.push("status:community");
        return ok({ states: [], total_points: 0 });
      }
      if (path === "/apihub/app/api/signIn" && request.method === "POST") {
        const body = await request.json() as { gids: string };
        requests.push("write:forum:" + body.gids);
        return ok({ gids: body.gids });
      }
      requests.push("unexpected:" + path);
      return new Response(null, { status: 404 });
    },
  });
  const clock = checkinScheduleClock();
  const pending = { forums: ["6"], games: ["zzz" as const], accountKey: key, verifiedUnsent: true as const,
    attempts: 1, nextAt: clock.iso, otherFailure: false };
  const preload = [
    'Bun.env.LOTUS_PROFILE_DIR = process.cwd() + "/profiles";',
    'Bun.env.LOTUS_PASSPORT_QR_RESOURCES = process.cwd() + "/missing-render-fixture";',
    'const originalFetch = globalThis.fetch;',
    'const source = ' + JSON.stringify(upstream.url.href) + ';',
    'globalThis.fetch = Object.assign(async (input, init) => {',
    '  const url = new URL(input instanceof Request ? input.url : input);',
    '  if (url.hostname === "127.0.0.1") return originalFetch(input, init);',
    '  const headers = new Headers(init?.headers);',
    '  headers.set("x-fixture-origin", url.hostname);',
    '  const result = await originalFetch(new URL(url.pathname + url.search, source), { ...init, headers });',
    '  return new Response(result.body, { status: result.status, headers: result.headers });',
    '}, originalFetch);',
  ].join("\n");

  try {
    await withDualGatewayFixture("checkin-named-synthetic", 'master: ["99:91", "100:92"]\n', async gateways => {
      const store = createCheckinScheduleStore(join(gateways.root, "data/schedules"));
      const read = async () => (await store.read(clock.date))!.entries[0]!;
      const group = { message_type: "group", sub_type: "normal", group_id: 77, sender: { user_id: 42, role: "member" } };
      const privateFields = { sender_id: 42, peer_id: 42 };
      expect((await read()).communityRetry).toEqual(pending);

      gateways.sendOneBot("#原神签到2", { ...group, sender: { user_id: 43, role: "member" } });
      gateways.sendOneBot("#社区原神签到2", { ...group, sub_type: "anonymous" });
      await Bun.sleep(150);
      expect(requests).toEqual([]);
      expect(gateways.onebot.calls).toEqual([]);
      expect((await read()).communityRetry).toEqual(pending);

      gateways.sendOneBot("#原神签到2", group);
      const unknown = await gateways.onebot.next("send_msg");
      expect(unknown.params).toMatchObject({ message_type: "group", group_id: 77,
        message: expect.stringContaining("原神 · 游戏 未确认 · 社区 不在本轮") });
      unknown.respond({ message_id: 130 });
      expect(queriedRoles).toBe(2);
      expect(requests).toEqual(["login:2", "login:4", "roles:hk4e_cn", "roles:hk4e_cn", "status:genshin", "write:genshin", "status:genshin"]);
      expect(await read()).toMatchObject({ done: false, communityRetry: pending,
        gameWrites: { [otherGame]: "confirmed", [genshin]: "unconfirmed" }, communityWrites: { "8": "accepted" } });

      expect((await gateways.sendMilky("#社区原神签到2", privateFields)).status).toBe(200);
      const community = await gateways.milky.next("send_private_message");
      expect(JSON.stringify(community.params)).toContain("原神 · 游戏 不在本轮 · 社区 已受理");
      community.respond({ message_seq: 131 });
      expect(requests.slice(-3)).toEqual(["status:community", "write:forum:2", "status:community"]);
      expect(await read()).toMatchObject({ done: false, communityRetry: pending, communityWrites: { "2": "accepted", "8": "accepted" },
        gameWrites: { [otherGame]: "confirmed", [genshin]: "unconfirmed" } });

      await gateways.sendMilky("#mys原神签到2", privateFields);
      const completed = await gateways.milky.next("send_private_message");
      expect(JSON.stringify(completed.params)).toContain("原神 · 游戏 不在本轮 · 社区 已受理");
      completed.respond({ message_seq: 132 });
      expect(requests.filter(line => line === "write:forum:2")).toHaveLength(1);

      signed = true;
      await gateways.sendMilky("#原神签到2", privateFields);
      const reread = await gateways.milky.next("send_private_message");
      expect(JSON.stringify(reread.params)).toContain("原神 · 游戏 已完成 · 社区 不在本轮");
      reread.respond({ message_seq: 133 });
      expect(requests.filter(line => line.startsWith("write:"))).toEqual(["write:genshin", "write:forum:2"]);
      expect(await read()).toMatchObject({ done: false, communityRetry: pending,
        gameWrites: { [otherGame]: "confirmed", [genshin]: "confirmed" }, communityWrites: { "2": "accepted", "8": "accepted" } });

      await gateways.sendMilky("#米游社崩坏3签到2", privateFields);
      const disabled = await gateways.milky.next("send_private_message");
      expect(JSON.stringify(disabled.params)).toContain("此档案未开启所选社区分区签到");
      disabled.respond({ message_seq: 134 });
      expect(requests.filter(line => line.startsWith("write:"))).toEqual(["write:genshin", "write:forum:2"]);
      await gateways.sendMilky("#社区全部签到2", privateFields);
      await Bun.sleep(160);
      expect(gateways.milky.calls).toEqual([]);

      const beforeDisconnect = await read();
      gateways.sendOneBot("#绝区零签到2", group);
      await Promise.race([roleReadStarted.promise, Bun.sleep(2000).then(() => { throw new Error("缺少所选游戏角色读取"); })]);
      const closed = Promise.withResolvers<void>();
      gateways.ws.addEventListener("close", () => closed.resolve(), { once: true });
      gateways.ws.close();
      await closed.promise;
      const heldRequests = [...requests];
      expect(heldRequests.at(-1)).toBe("roles:nap_cn");
      releaseRoleRead.resolve();
      await Bun.sleep(250);
      expect(requests).toEqual(heldRequests);
      expect(await read()).toEqual(beforeDisconnect);
    }, 9000, preload, async root => {
      const profiles = join(root, "profiles");
      await mkdir(profiles);
      await writeFile(join(profiles, "42-2.yaml"), Bun.YAML.stringify({
        enabled: true, user: { qq: "42" }, profile: { id: 2 },
        account: { stuid: accountId, ltuid: accountId, stoken: "v2_fixture-login", mid: "fixture-mid",
          cookie: "ltuid_v2=81526;ltmid_v2=fixture-mid;ltoken_v2=v2_fixture;cookie_token_v2=v2_cookie" },
        device: { id: "fixture-device", fp: "fixture-fp", bound: true },
        games: { cn: { enable: true, genshin: { checkin: true }, honkai_sr: { checkin: true }, zzz: { checkin: true } } },
        mihoyobbs: { enable: true, tasks: { checkin: true }, checkin_list: [2, 6, 8] },
        cloud_games: { cn: { genshin: { enable: true, token: "fixture-cloud" } } },
      }));
      await writeFile(join(root, "config/global.yaml"), "scheduler: {enable: false}\n");
      const plan = generateCheckinSchedulePlan({ date: clock.date, profiles: [{ qq: "42", profileId: 2, enabled: true }] });
      const entry = { ...plan.entries[0]!, communityRetry: pending, gameWriteAccount: key, gameWrites: { [otherGame]: "confirmed" as const },
        communityWrites: { "8": "accepted" as const }, communityWriteAccount: key };
      await createCheckinScheduleStore(join(root, "data/schedules")).update(clock.date, () => ({ plan: { ...plan, entries: [entry] }, result: undefined }));
    });
  } finally {
    releaseRoleRead.resolve();
    await upstream.stop(true);
  }
}, 18000);
