import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { runGuardedLegacyCheckinTransfer } from "../lib/checkin-schedule-handback.ts";
import { checkinScheduleClock, generateCheckinSchedulePlan, legacyGameWriteKey } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleRuntime } from "../lib/checkin-schedule-runtime.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { gameCheckinCommands } from "../lib/game-checkin-commands.ts";

const qq = "91001";
const profileId = 2;
const ok = (data: object) => Response.json({ retcode: 0, data });
type Origin = "chat" | "web" | "scheduled";

async function fixture(run: (helpers: {
  run: (origin: Origin) => Promise<unknown>;
  read: () => ReturnType<ReturnType<typeof createCheckinScheduleStore>["read"]>;
  lock: <Value>(operation: () => Promise<Value>) => Promise<unknown>;
  advance: (at: number) => void;
  acknowledgeGameWrite: () => void;
  importLegacyGame: (status: "unknown" | "completed") => Promise<void>;
  writes: string[];
  reads: string[];
}) => Promise<void>, { disabled = false, succeed = false, extraForum = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lotus-checkin-shared-writes-"));
  try {
    const date = checkinScheduleClock().date;
    let at = Date.parse(date + "T18:45:00+08:00");
    const store = createCheckinScheduleStore(join(root, "plans"));
    const profiles = createProfileStore(root);
    const writes: string[] = [], reads: string[] = [];
    let signed = false;
    await writeFile(join(root, `${qq}-${profileId}.yaml`), Bun.YAML.stringify({
      enabled: !disabled, user: { qq }, profile: { id: profileId },
      account: { stuid: "81526", ltuid: "81526", mid: "fixture", stoken: "v2_fixture-login",
        cookie: "ltuid_v2=81526; ltmid_v2=fixture; ltoken_v2=v2_fixture; cookie_token_v2=v2_fixture-cookie" },
      device: { id: "fixture-device", fp: "fixture-fp", bound: true },
      games: { cn: { enable: true, genshin: { checkin: true }, honkai_sr: { checkin: false }, zzz: { checkin: false } } },
      mihoyobbs: { enable: true, tasks: { checkin: true }, checkin_list: extraForum ? [6, 8] : [6] },
    }));
    await run({
      read: () => store.read(date), lock: operation => store.withExecutionLock(date, operation), writes, reads,
      advance: value => { at = value; },
      acknowledgeGameWrite: () => { signed = true; },
      async importLegacyGame(status) {
        const accountKey = createHash("sha256").update(JSON.stringify([qq, profileId, "81526"])).digest("hex");
        const plan = generateCheckinSchedulePlan({ date, now: at, profiles: [{ qq, profileId, enabled: true }] });
        await store.update(date, () => ({ plan: { ...plan, entries: [{ ...plan.entries[0]!, communityRetry: {
          forums: ["6"], games: ["genshin"], attempts: 1, nextAt: new Date(at).toISOString(), accountKey, verifiedUnsent: true,
        } }] }, result: undefined }));
        expect(await runGuardedLegacyCheckinTransfer(store, date, {
          now: () => at, loadAccount: profiles.accountContext, async runInline({ entries, ...offer }) {
            return { ...offer, entries: entries.map(({ qq, profileId, accountKey }) => ({
              qq, profileId, accountKey, attempts: 2, nextAt: new Date(at + 60_000).toISOString(),
              outcomes: [{ target: "game:genshin", status }, { target: "community:6", status: "unsent" }],
            })) };
          },
        })).toEqual({ acquired: true, value: 1 });
      },
      async run(origin) {
        const controller = new AbortController();
        const module = gameCheckinCommands(root, controller.signal, {
          scheduleStore: store,
          makeClient: (profiles, transport) => ({
            ...createProfileHoyoClient(profiles, transport), refreshCredentials: async account => account,
          }),
          async renderReceipt() { throw new Error("测试使用文字回执"); },
          async transport(url, init) {
            if (url.pathname.endsWith("getUserGameRolesByCookie")) return ok({ list: [
              { game_biz: "hk4e_cn", game_uid: "100000031", region: "cn_gf01" },
            ] });
            if (url.pathname.endsWith("/info")) {
              reads.push(origin);
              return ok({ is_sign: signed, first_bind: false });
            }
            if (url.pathname.endsWith("/getUserMissionsState")) return ok({ states: [] });
            if (url.pathname.endsWith("/sign") && init.method === "POST") {
              writes.push("game:" + origin);
              signed = succeed;
              return succeed ? ok({}) : new Response(null, { status: 503 });
            }
            if (url.pathname.endsWith("/signIn") && init.method === "POST") {
              const { gids } = JSON.parse(String(init.body));
              writes.push((gids === "6" ? "community:" : `community-${gids}:`) + origin);
              if (gids === "8") return ok({ gids });
              return succeed ? ok({ gids: 6 }) : new Response(null, { status: 503 });
            }
            throw new Error("未授权出站请求");
          },
        });
        const runtime = createCheckinScheduleRuntime({
          store, signal: controller.signal, config: { fixed_time: "18:00" }, now: () => at, listProfiles: profiles.listCheckinProfiles,
          runProfile: (entry, context) => module.runScheduled(entry.qq, entry.profileId, context),
        });
        try {
          if (origin === "scheduled") return await runtime.runDue();
          if (origin === "web") return await module.runWeb(qq, profileId, { signal: controller.signal, verifySession: async () => {} });
          return await module.fallback!("", { normalizedMessage: "#手动签到2", message_type: "private", user_id: Number(qq),
            reply: async () => true, isBotMaster: () => false, isMaster: false, privateCredentialSignal: controller.signal });
        } finally {
          controller.abort();
          await runtime.stop();
        }
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [first, second, third] of [["web", "scheduled", "chat"], ["scheduled", "chat", "web"], ["chat", "web", "scheduled"]] as const) {
  test(`同档 ${first} 结果未知后，${second} 与 ${third} 都不会再次提交`, () => fixture(async ({ run, read, reads, writes }) => {
    await run(first);
    const initial = (await read())!.entries[0]!;
    expect(initial).toMatchObject({ profileId, communityWrites: { "6": "unconfirmed" } });
    expect(Object.values(initial.gameWrites!)).toEqual(["unconfirmed"]);
    if (first !== "scheduled") expect(initial).toMatchObject({ manualOnly: true, done: false });
    await run(second);
    await run(third);
    const entry = (await read())!.entries[0]!;
    expect(entry).toMatchObject({ time: "18:00", done: true, ok: false, communityWrites: { "6": "unconfirmed" } });
    expect(entry.manualOnly).toBeUndefined();
    expect(Object.values(entry.gameWrites!)).toEqual(["unconfirmed"]);
    expect(writes).toEqual([`game:${first}`, `community:${first}`]);
    expect(reads).toContain(second);
    expect(reads).toContain(third);
  }));
}

test("定时已占用日期时手动不发写；停用自动的档案仍可以正常手动签到", () => fixture(async ({ run, read, lock, writes }) => {
  await lock(async () => {
    expect(await run("web")).toMatchObject({ status: "busy" });
    expect(writes).toEqual([]);
  });
  expect(await run("web")).toMatchObject({ status: "completed" });
  expect(writes).toEqual(["game:web", "community:web"]);
  expect((await read())?.entries[0]).toMatchObject({ done: false, manualOnly: true,
    communityWrites: { "6": "accepted" } });
  expect(await run("scheduled")).toMatchObject({ completed: 0 });
  expect(writes).toEqual(["game:web", "community:web"]);
}, { disabled: true, succeed: true }));

test("网页结果未知后的独立分区由当天定时补跑接回", () => fixture(async ({ run, read, advance, writes }) => {
  expect(await run("web")).toMatchObject({ status: "failed" });
  expect(writes).toEqual(["game:web", "community:web"]);
  await run("scheduled");
  const pending = (await read())!.entries[0]!;
  expect(pending).toMatchObject({ done: false, communityRetry: { forums: ["8"], verifiedUnsent: true } });
  expect(writes).toEqual(["game:web", "community:web"]);
  advance(Date.parse(pending.communityRetry!.nextAt));
  expect(await run("scheduled")).toMatchObject({ completed: 1 });
  expect(writes).toEqual(["game:web", "community:web", "community-8:scheduled"]);
  expect((await read())?.entries[0]).toMatchObject({ done: true, ok: false,
    communityWrites: { "6": "unconfirmed", "8": "accepted" } });
}, { extraForum: true }));

test("跨入口回读发现原游戏确已签到时确认原记录", () => fixture(async ({ run, read, acknowledgeGameWrite, writes }) => {
  await run("scheduled");
  expect(Object.values((await read())!.entries[0]!.gameWrites!)).toEqual(["unconfirmed"]);
  acknowledgeGameWrite();
  await run("chat");
  expect(Object.values((await read())!.entries[0]!.gameWrites!)).toEqual(["confirmed"]);
  expect(writes).toEqual(["game:scheduled", "community:scheduled"]);
}));

for (const imported of ["unknown", "completed"] as const) {
  test(`旧回执游戏 ${imported} 后手动只回读该游戏，社区照常补跑`, () => fixture(async ({ run, read, importLegacyGame, advance, reads, writes }) => {
    await importLegacyGame(imported);
    const pending = (await read())!.entries[0]!;
    const gameState = imported === "unknown" ? "unconfirmed" : "confirmed";
    expect(pending).toMatchObject({ done: false, gameWrites: { [legacyGameWriteKey("genshin")]: gameState },
      communityRetry: { forums: ["6"], verifiedUnsent: true } });
    await run("web");
    expect(reads).toEqual(["web"]);
    expect(writes).toEqual(["community:web"]);
    advance(Date.parse(pending.communityRetry!.nextAt));
    expect(await run("scheduled")).toMatchObject({ completed: 1 });
    expect((await read())?.entries[0]).toMatchObject({ done: true, communityWrites: { "6": "accepted" },
      gameWrites: { [legacyGameWriteKey("genshin")]: gameState } });
    expect(writes).toEqual(["community:web"]);
  }, { succeed: true }));
}
