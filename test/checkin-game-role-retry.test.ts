import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { createCheckinScheduleRuntime } from "../lib/checkin-schedule-runtime.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { gameCheckinCommands } from "../lib/game-checkin-commands.ts";

const date = "2026-11-19";
const qq = "10001";
const profileId = 2;
const roleUid = "100000015";
const scheduled = Date.parse(date + "T19:00:00+08:00");
const ok = (data: object) => Response.json({ retcode: 0, data });

function profile(accountId = "67890", mid = "fixture-mid") {
  return Bun.YAML.stringify({
    enabled: true, user: { qq }, profile: { id: profileId },
    games: { cn: { enable: true, genshin: { checkin: true }, honkai_sr: { checkin: true }, zzz: { checkin: true } } },
    mihoyobbs: { enable: true, tasks: { checkin: true }, checkin_list: [6] },
    account: { stuid: accountId, ltuid: accountId, mid, stoken: "v2_fixture-login",
      cookie: `ltuid_v2=${accountId}; ltmid_v2=${mid}; ltoken_v2=v2_fixture; cookie_token_v2=v2_fixture-cookie` },
    device: { id: "fixture-device", fp: "fixture-fp", bound: true },
  });
}

async function fixture(testRun: (root: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-checkin-game-roles-"));
  const path = join(root, `${qq}-${profileId}.yaml`);
  try {
    await writeFile(path, profile());
    await testRun(root, path);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("实际定时运行可同档持久保存待查角色和社区补跑，两类独立收尾且不重复签到提交", () =>
  fixture(async (root, path) => {
    const trace: string[] = [];
    let at = scheduled;
    let round = 1;
    let signed = false;
    let genshinReads = 0;
    async function tick() {
      const abort = new AbortController();
      const store = createCheckinScheduleStore(join(root, "plans"));
      const profiles = createProfileStore(root);
      const gameCheckin = gameCheckinCommands(root, abort.signal, {
        makeClient(profiles, transport) {
          return { ...createProfileHoyoClient(profiles, transport), refreshCredentials: async account => account };
        },
        async renderReceipt() { throw new Error("测试使用文字回执"); },
        async waitForReadRetry(ms, signal) {
          signal.throwIfAborted();
          trace.push(`wait:${ms}`);
        },
        async transport(url, init) {
          if (url.pathname.endsWith("/getUserGameRolesByCookie")) {
            const game = url.searchParams.get("game_biz");
            expect(new Headers(init.headers).get("Cookie")).toContain("ltuid_v2=67890");
            expect(url.origin).toBe("https://api-takumi.mihoyo.com");
            trace.push(`roles:${game}`);
            if (game === "hk4e_cn") return ++genshinReads === 1 ? new Response(null, { status: 410 }) :
              ok({ list: [{ game_biz: game, game_uid: roleUid, region: "cn_gf01" }] });
            if (game === "hkrpg_cn") return round < 3 ? new Response(null, { status: 410 }) :
              ok({ list: [{ game_biz: game, game_uid: "100000016", region: "prod_gf_cn" }] });
            expect(game).toBe("nap_cn");
            return round === 1 ? new Response(null, { status: 429 }) : ok({ list: [] });
          }
          if (url.pathname.endsWith("/getUserMissionsState")) {
            trace.push("community:read");
            return round === 1 ? new Response(null, { status: 503 }) : ok({ states: [] });
          }
          if (url.pathname.endsWith("/signIn")) {
            expect(JSON.parse(String(init.body))).toEqual({ gids: "6" });
            trace.push("community:submit");
            return ok({ gids: 6 });
          }
          const game = url.pathname.includes("/hkrpg/") ? "sr" : "gs";
          if (url.pathname.endsWith("/info")) {
            trace.push(`${game}:read`);
            return ok({ is_sign: game === "sr" || signed, first_bind: false, total_sign_day: 1 });
          }
          if (url.pathname.endsWith("/sign")) {
            trace.push(`${game}:submit`);
            signed = true;
            return ok({});
          }
          throw new Error("Unexpected fixture operation");
        },
      });
      const runtime = createCheckinScheduleRuntime({
        store, signal: abort.signal, config: { mode: "fixed", fixed_time: "18:00" }, now: () => at,
        listProfiles: profiles.listCheckinProfiles, runProfile: (entry, context) => gameCheckin.runScheduled(entry.qq, entry.profileId, context),
      });
      try {
        const result = await runtime.runDue();
        expect(result?.status).toBe("complete");
        return (await store.read(date))?.entries[0];
      } finally {
        abort.abort();
        await runtime.stop();
      }
    }

    const first = await tick();
    expect(first).toMatchObject({ done: false, ok: false, communityRetry: {
      games: ["honkai_sr", "zzz"], forums: ["6"], attempts: 0, verifiedUnsent: true, nextAt: new Date(at + 600_000).toISOString(),
    } });
    expect(trace.splice(0)).toEqual([
      "roles:hk4e_cn", "wait:5000", "roles:hk4e_cn", "gs:read", "gs:submit", "gs:read",
      "roles:hkrpg_cn", "wait:5000", "roles:hkrpg_cn", "wait:15000", "roles:hkrpg_cn", "roles:nap_cn",
      "community:read", "wait:5000", "community:read", "wait:15000", "community:read",
    ]);
    at += 600_000;
    round = 2;
    await writeFile(path, profile("67890", "fixture-renewed-mid"));
    expect(await tick()).toMatchObject({ done: false, ok: false, communityRetry: {
      games: ["honkai_sr"], forums: [], attempts: 1, verifiedUnsent: true, nextAt: new Date(at + 3_600_000).toISOString(),
    }, communityWrites: { "6": "accepted" } });
    expect(trace.splice(0)).toEqual([
      "roles:hkrpg_cn", "wait:5000", "roles:hkrpg_cn", "wait:15000", "roles:hkrpg_cn",
      "roles:nap_cn", "community:read", "community:submit",
    ]);
    at += 3_600_000;
    round = 3;
    const finished = await tick();
    expect(finished).toMatchObject({ done: true, ok: true, communityWrites: { "6": "accepted" } });
    expect(finished?.communityRetry).toBeUndefined();
    expect(trace.splice(0)).toEqual(["roles:hkrpg_cn", "sr:read"]);
    expect(await tick()).toEqual(finished);
    expect(trace).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(profile("67890", "fixture-renewed-mid"));
  }));

test("签到提交状态未知不会入队，日末补跑拒绝换绑后的档案", () =>
  fixture(async (root, path) => {
    let at = Date.parse(date + "T23:58:00+08:00");
    const traces: string[] = [];
    async function tick(onlyRetries = false) {
      const abort = new AbortController();
      const store = createCheckinScheduleStore(join(root, "plans"));
      const profiles = createProfileStore(root);
      const module = gameCheckinCommands(root, abort.signal, {
        makeClient(profiles, transport) {
          return { ...createProfileHoyoClient(profiles, transport), refreshCredentials: async account => account };
        },
        async renderReceipt() { throw new Error("测试使用文字回执"); },
        async waitForReadRetry() {},
        async transport(url) {
          const game = url.searchParams.get("game_biz");
          traces.push(game ?? url.pathname);
          if (game === "hk4e_cn") return ok({ list: [{ game_biz: game, game_uid: roleUid, region: "cn_gf01" }] });
          if (game === "hkrpg_cn") return new Response(null, { status: 410 });
          if (game === "nap_cn") return new Response(null, { status: 401 });
          if (url.pathname.endsWith("/info")) return ok({ is_sign: false, first_bind: false });
          if (url.pathname.endsWith("/sign")) return new Response(null, { status: 502 });
          if (url.pathname.endsWith("/getUserMissionsState")) return ok({ states: [] });
          if (url.pathname.endsWith("/signIn")) return ok({ gids: 6 });
          throw new Error("Unexpected fixture operation");
        },
      });
      const runtime = createCheckinScheduleRuntime({
        store, signal: abort.signal, config: { mode: "fixed", fixed_time: "18:00" }, now: () => at,
        listProfiles: profiles.listCheckinProfiles, runProfile: (entry, context) => module.runScheduled(entry.qq, entry.profileId, context),
      });
      try {
        expect(await runtime.runDue(onlyRetries)).toMatchObject({ status: "complete" });
        return (await store.read(date))?.entries[0];
      } finally {
        abort.abort();
        await runtime.stop();
      }
    }

    expect(await tick()).toMatchObject({ done: false, ok: false, communityRetry: {
      forums: [], games: ["honkai_sr"], otherFailure: true, verifiedUnsent: true,
      nextAt: new Date(Date.parse(date + "T23:59:00+08:00")).toISOString(),
    } });
    expect(traces.filter(operation => operation === "/event/luna/sign")).toHaveLength(1);
    expect(traces.filter(operation => operation === "/event/luna/info")).toHaveLength(2);
    traces.length = 0;
    await writeFile(path, profile("67891"));
    at += 60_000;
    const final = await tick(true);
    expect(final).toMatchObject({ done: true, ok: false, stage: "precheck" });
    expect(final?.communityRetry).toBeUndefined();
    expect(traces).toEqual([]);
  }));

test("社区提交未知时，仅同档未提交的其他分区进入当天补跑", () =>
  fixture(async (root, path) => {
    const document = Bun.YAML.parse(profile()) as Record<string, unknown>;
    document.games = { cn: { enable: false } };
    document.mihoyobbs = { enable: true, tasks: { checkin: true }, checkin_list: [6, 8] };
    await writeFile(path, Bun.YAML.stringify(document));
    let at = scheduled;
    const writes: string[] = [];
    const store = createCheckinScheduleStore(join(root, "plans"));
    const profiles = createProfileStore(root);
    const signal = new AbortController();
    const module = gameCheckinCommands(root, signal.signal, {
      async renderReceipt() { throw new Error("测试使用文字回执"); },
      async transport(url, init) {
        if (url.pathname.endsWith("/getUserMissionsState")) return ok({ states: [] });
        if (url.pathname.endsWith("/signIn")) {
          const { gids } = JSON.parse(String(init.body));
          writes.push(gids);
          return gids === "6" ? new Response(null, { status: 503 }) : ok({ gids: 8 });
        }
        throw new Error("Unexpected fixture operation");
      },
    });
    const runtime = createCheckinScheduleRuntime({
      store, signal: signal.signal, config: { mode: "fixed", fixed_time: "18:00" }, now: () => at,
      listProfiles: profiles.listCheckinProfiles, runProfile: (entry, context) => module.runScheduled(entry.qq, entry.profileId, context),
    });
    try {
      expect(await runtime.runDue()).toMatchObject({ deferred: 1 });
      const entry = (await store.read(date))!.entries[0]!;
      expect(entry).toMatchObject({ done: false, communityWrites: { "6": "unconfirmed" },
        communityRetry: { forums: ["8"], verifiedUnsent: true, otherFailure: true } });
      expect(writes).toEqual(["6"]);
      at = Date.parse(entry.communityRetry!.nextAt);
      expect(await runtime.runDue(true)).toMatchObject({ completed: 1 });
      expect((await store.read(date))?.entries[0]).toMatchObject({ done: true, ok: false,
        communityWrites: { "6": "unconfirmed", "8": "accepted" } });
      expect(writes).toEqual(["6", "8"]);
    } finally {
      signal.abort();
      await runtime.stop();
    }
  }));

test("游戏提交后中止，重新领取时只回读该角色，其余从未提交的游戏独立完成", () =>
  fixture(async (root, path) => {
    const document = Bun.YAML.parse(profile()) as Record<string, unknown>;
    document.games = { cn: { enable: true, genshin: { checkin: true }, honkai_sr: { checkin: true }, zzz: { checkin: false } } };
    document.mihoyobbs = { enable: false };
    await writeFile(path, Bun.YAML.stringify(document));
    const store = createCheckinScheduleStore(join(root, "plans"));
    const profiles = createProfileStore(root);
    const writes: string[] = [];
    const reads: string[] = [];
    let signed = false;
    async function run(interrupt = false) {
      const controller = new AbortController();
      const module = gameCheckinCommands(root, controller.signal, {
        makeClient(profiles, transport) {
          return { ...createProfileHoyoClient(profiles, transport), refreshCredentials: async account => account };
        },
        async renderReceipt() { throw new Error("测试使用文字回执"); },
        async transport(url) {
          const game = url.searchParams.get("game_biz");
          if (game) return ok({ list: [game === "hkrpg_cn"
            ? { game_biz: game, game_uid: "100000016", region: "prod_gf_cn" }
            : { game_biz: game, game_uid: roleUid, region: "cn_gf01" }] });
          const title = url.pathname.includes("/hkrpg/") ? "sr" : "gs";
          if (url.pathname.endsWith("/info")) {
            reads.push(title);
            return ok({ is_sign: title === "sr" && signed, first_bind: false });
          }
          if (url.pathname.endsWith("/sign")) {
            writes.push(title);
            expect(Object.values((await store.read(date))!.entries[0]!.gameWrites ?? {})).toContain("pending");
            if (interrupt) {
              controller.abort();
              throw new Error("模拟在送达请求后中止");
            }
            signed = true;
            return ok({});
          }
          throw new Error("Unexpected fixture operation");
        },
      });
      const runtime = createCheckinScheduleRuntime({
        store, signal: controller.signal, config: { mode: "fixed", fixed_time: "18:00" }, now: () => scheduled,
        listProfiles: profiles.listCheckinProfiles, runProfile: (entry, context) => module.runScheduled(entry.qq, entry.profileId, context),
      });
      try { return await runtime.runDue(); }
      finally { controller.abort(); await runtime.stop(); }
    }
    expect(await run(true)).toMatchObject({ status: "interrupted" });
    expect(writes).toEqual(["gs"]);
    expect(Object.values((await store.read(date))!.entries[0]!.gameWrites!)).toEqual(["pending"]);
    expect(await run()).toMatchObject({ completed: 1 });
    expect(writes).toEqual(["gs", "sr"]);
    expect(reads).toEqual(["gs", "gs", "sr", "sr"]);
    expect(Object.values((await store.read(date))!.entries[0]!.gameWrites!)).toEqual(["unconfirmed", "confirmed"]);
    expect(await run()).toMatchObject({ completed: 0 });
    expect(writes).toEqual(["gs", "sr"]);
  }));
