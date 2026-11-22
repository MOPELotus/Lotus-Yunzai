import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import type { BotNotifications } from "../lib/checkin-notify.ts";
import { panelZzzSettings } from "../lib/panel-zzz-settings.ts";
import { resolvePrivateFriendRoute } from "../lib/private-friend-route.ts";
import { createZzzChallengeReminders } from "../plugins/zzz/challenge-reminder.ts";
import { startZzzChallengeReminders, type ZzzReminderRuntime } from "../plugins/zzz/challenge-reminder-runtime.ts";
import { challengeReminderWindow, createZzzChallengeReminderStore } from "../plugins/zzz/challenge-reminder-store.ts";

const valkey = Bun.which("valkey-server");
const oldUsers = "ZZZ:REMIND:USER_CONFIGS";
const start = Date.parse("2026-11-22T12:00:00Z");
const ninth = start + 9 * 60_000 + 59_999;
const response = (data: unknown) => Response.json({ retcode: 0, data });

test("挑战提醒依北京时间匹配每日和每周的十分钟窗口", () => {
  expect(challengeReminderWindow("每周天20时", start - 1)).toBeUndefined();
  expect(challengeReminderWindow("每周日20时", start)).toBe("2026-11-22");
  expect(challengeReminderWindow("每日20时", ninth)).toBe("2026-11-22");
  expect(challengeReminderWindow("每日20时", ninth + 1)).toBeUndefined();
  expect(challengeReminderWindow("每周一20时", start)).toBeUndefined();
  expect(challengeReminderWindow("每日0时", Date.parse("2026-11-21T16:01:00Z"))).toBe("2026-11-22");
});

test("旧 QQ 只选唯一可证好友，绑定机器人不会退回另一路，未知候选和离线候选停发", async () => {
  let state: boolean | undefined = false, active = true, present = true;
  const deliveries: number[] = [];
  function bot(botId: number, check: () => boolean | undefined): BotNotifications {
    return { botId, async friendship() { return check(); }, async isFriend() { return check() === true; },
      async isGroupMember() { throw new Error("应使用私聊"); }, async sendGroup() { throw new Error("应使用私聊"); },
      async sendPrivate() { deliveries.push(botId); return "confirmed"; } };
  }
  const one = bot(99, () => true), milky = bot(100, () => state);
  const route = (botId?: number) => resolvePrivateFriendRoute(() => present ? [one, milky] : [one], 42, botId, () => active, () => [99, 100]);
  const first = await route();
  expect(first?.botId).toBe(99);
  await first?.send("合成提醒");
  state = true;
  expect(await route()).toBeUndefined();
  const bound = await route(100);
  await bound?.send("合成提醒");
  state = undefined;
  expect(await route()).toBeUndefined();
  expect(await route(100)).toBeUndefined();
  expect((await route(99))?.botId).toBe(99);
  present = false;
  expect(await route()).toBeUndefined();
  expect(await bound?.send("已下线")).toBe("rejected");
  active = false;
  expect(await route(99)).toBeUndefined();
  expect(deliveries).toEqual([99, 100]);
});

test.skipIf(!valkey)("隔离定时轮询尊重本人撤回、窗口和换绑，跨任务实例丢回执仍只发一次", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-reminder-timer-"));
  const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop(true);
  const secret = crypto.randomUUID();
  const server = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", secret,
    "--save", "", "--appendonly", "no", "--dir", root], { stdout: "pipe", stderr: "ignore" });
  const before = globalThis.redis;
  try {
    const reader = server.stdout.getReader();
    let banner = "";
    while (!banner.includes("Ready to accept connections")) {
      const item = await reader.read();
      if (item.done) throw new Error("隔离 Valkey 初始化失败。");
      banner += new TextDecoder().decode(item.value);
    }
    reader.releaseLock();
    const redis = await connectStorage(`redis://:${secret}@127.0.0.1:${port}`);
    globalThis.redis = redis;
    const store = createZzzChallengeReminderStore(redis, join(root, "absent-legacy.yaml"));
    const roleArchive = join(root, "42.yaml");
    const profile = (selected: string, token = "fixture-old") => [
      'user: { qq: "42" }', "profile: { id: 1 }", "account:",
      `  cookie: "cookie_token=${token}; account_id=43"`, '  stoken: "fixture-stoken"', '  stuid: "43"',
      '  game_roles: { zzz: [{ uid: "12345678", region: prod_gf_cn, game_biz: nap_cn }] }',
      `  current_uid: { zzz: "${selected}" }`, 'device: { id: "fixture-device", fp: "fixture-fp" }',
    ].join("\n");
    const original = JSON.stringify({ enable: true, abyssCheckLevel: 0, deadlyStars: 6 });
    await redis.hSet(oldUsers, "42", original);
    await writeFile(roleArchive, profile("12345678"), { mode: 0o600 });
    await store.updateGlobal("enable", true);
    await store.updateGlobal("remindTime", "每日20时");
    const profiles = createProfileStore(root);
    let now = start, friend = true;
    let interruption: "close-window" | "pause" | "not-friend" | "changed-role" | undefined;
    const calls: string[] = [], delivery: string[] = [];
    const client = createProfileHoyoClient(profiles, async (url, request) => {
      const action = url.pathname.split("/").at(-1)!;
      calls.push(action);
      if (action === "getLTokenBySToken") return response({ uid: "43", ltoken: "fixture-fresh" });
      if (action === "getCookieAccountInfoBySToken") return response({ uid: "43", cookie_token: "fixture-fresh" });
      expect(action).toBe("hadal_mem_detail_v2");
      expect(url.searchParams.get("uid")).toBe("12345678");
      expect(url.searchParams.get("schedule_type")).toBe("1");
      if (!new Headers(request.headers).get("Cookie")?.includes("fixture-fresh")) return Response.json({ retcode: -100 });
      if (interruption === "close-window") now += 10 * 60_000;
      if (interruption === "pause") await store.updateGlobal("enable", false);
      if (interruption === "not-friend") friend = false;
      if (interruption === "changed-role") await writeFile(roleArchive, profile("67345678", "fixture-fresh"));
      return response({ has_data: true, total_star: 0 });
    });
    function service() {
      const controller = new AbortController();
      let run: (() => Promise<void>) | undefined;
      const runtime: ZzzReminderRuntime = {
        disconnect: controller.signal,
        registerTask(callback) { run = callback; return async () => { controller.abort(); }; },
        async route(user, botId) {
          expect(user).toBe(42);
          expect(botId === 99 || botId === undefined).toBe(true);
          if (!friend) return;
          return { botId: 99, async send(text) { delivery.push(text); return "unknown"; } };
        },
      };
      const stop = startZzzChallengeReminders(profiles, client, runtime, controller.signal, () => now);
      return { run: run!, stop };
    }
    const first = service(), second = service();
    await Promise.all([first.run(), second.run()]);
    expect(calls).toEqual(["hadal_mem_detail_v2", "getLTokenBySToken", "getCookieAccountInfoBySToken", "hadal_mem_detail_v2"]);
    expect(delivery).toEqual(["【式舆/危局挑战提醒】\n危局强袭战星数: 0/9"]);
    await first.stop();
    const restarted = service();
    await restarted.run();
    expect(delivery).toHaveLength(1);
    expect(calls).toHaveLength(4);
    for (const [index, reason] of (["close-window", "pause", "not-friend", "changed-role"] as const).entries()) {
      now = start + (index + 1) * 86_400_000;
      await writeFile(roleArchive, profile("12345678", "fixture-fresh"), { mode: 0o600 });
      await store.updateGlobal("enable", true);
      friend = true;
      interruption = reason;
      const requestCount = calls.length;
      await restarted.run();
      expect(calls.length).toBe(requestCount + 1);
      expect(delivery).toHaveLength(1);
    }
    await store.updateGlobal("enable", false);
    const command = createZzzChallengeReminders(profiles, client, new AbortController().signal);
    expect(await command({ user_id: 42, self_id: 99, message_type: "group", async isFriend() { return false; }, reply() {} },
      { kind: "enable", global: false, enabled: false })).toBe("提醒功能已关闭");
    expect((await store.user("42"))?.enable).toBe(false);
    expect(await redis.hGet(oldUsers, "42")).toBe(original);
    await store.updateGlobal("enable", true);
    now = start + 7 * 86_400_000;
    await second.run();
    expect(delivery).toHaveLength(1);
    await writeFile(roleArchive, profile("12345678", "fixture-fresh"), { mode: 0o600 });
    const caller = { user_id: 42, message_type: "private", async isFriend() { return true; }, reply() {} };
    expect(await command({ ...caller, self_id: 99 }, { kind: "enable", global: false, enabled: true })).toContain("提醒功能已开启");
    expect(await store.user("42")).toMatchObject({ enable: true, botId: 99 });
    expect(await command({ ...caller, self_id: 100 }, { kind: "enable", global: false, enabled: true })).toContain("提醒功能已开启");
    expect(await store.user("42")).toMatchObject({ enable: true, botId: 100 });
    await restarted.stop();
    await second.stop();

    const panel = panelZzzSettings(pathToFileURL(root + "/"), "reminders");
    const endpoint = "http://localhost/panel/api/settings/games/zzz-reminders";
    const snapshotReply = await panel(new Request(endpoint), () => true);
    const initial = await snapshotReply.json();
    expect(initial.fields.map((field: { key: string }) => field.key))
      .toEqual(["enable", "abyssCheckLevel", "deadlyStars", "remindTime"]);
    const previous = initial.values;
    const updated = { enable: false, abyssCheckLevel: 6, deadlyStars: 8, remindTime: "每周五21时30分" };
    const save = (values: object) => new Request(endpoint, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ previous, values }) });
    expect((await panel(save({ ...updated, remindTime: "每日20时15分" }), () => true)).status).toBe(400);
    expect((await panel(save(updated), () => false)).status).toBe(401);
    let checks = 0;
    expect((await panel(save(updated), () => ++checks === 1)).status).toBe(401);
    expect(await store.global()).toEqual(previous);
    expect((await panel(save(updated), () => true)).status).toBe(200);
    expect(await store.global()).toEqual(updated);
    expect((await panel(save(updated), () => true)).status).toBe(409);
    await store.updateGlobal("enable", true);
    expect((await (await panel(new Request(endpoint), () => true)).json()).values).toEqual({ ...updated, enable: true });
    expect(await store.user("42")).toMatchObject({ enable: true, botId: 100 });
  } finally {
    globalThis.redis = before;
    await closeStorage();
    server.kill();
    await server.exited;
    await rm(root, { recursive: true, force: true });
  }
});
