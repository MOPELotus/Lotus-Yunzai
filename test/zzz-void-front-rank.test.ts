import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeZzzHoloBoss, normalizeZzzVoidFront } from "@lotus-yunzai/hoyo-client";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { rankCommand, rankRow, sortedRankRows } from "../plugins/zzz/challenge-rank-model.ts";
import { createChallengeRankStore } from "../plugins/zzz/challenge-rank-store.ts";

const valkey = Bun.which("valkey-server");
const profile = { qq: "42", profileId: 2, uid: "12345678", region: "prod_gf_cn", nickname: "合成会员" } as const;
const mode = "VOID_FRONT_BATTLE";
const group = "77";
const other = "78";
const field = "prod_gf_cn:12345678";
const phase = Math.floor(Date.now() / 1000) * 1000;
const rankEndsAt = phase + 3600 * 1000;
const old = `ZZZ:RANK:${mode}:${group}:${profile.uid}`;
const oldOwner = `ZZZ:RANK:UID2QQS:${group}:${profile.uid}:${profile.qq}`;
const modern = `lotus-yunzai:zzz-challenge-ranks:${group}:${mode}`;

function wall(millis: number) {
  const date = new Date(millis + 8 * 3_600_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(),
    minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

function source(score: number, ending = true) {
  return {
    void_front_battle_abstract_info_brief: {
      total_score: score, start_time: wall(phase - 86400 * 1000), end_time: wall(rankEndsAt),
      end_ts: String(rankEndsAt / 1000), has_ending_record: ending,
    },
    boss_challenge_record: { boss_info: { name: "最终关" }, main_challenge_record: {
      name: "终关", star: "S+", score: 182000, challenge_time: wall(phase - 6000),
      sub_challenge_record: [{ name: "子关", challenge_time: wall(phase - 2000) }],
    } },
    main_challenge_record_list: [{ name: "普通关", star: "A+", challenge_time: wall(phase - 4000) }],
  };
}

const snapshot = (score: number, ending = true) =>
  normalizeZzzVoidFront({ void_front_battle_detail: source(score, ending) }, { ...profile, scheduleType: 1 });

test("临界群榜沿用已完成结局和 Unix end_ts，完全同分按最后主关通关时间", () => {
  expect(rankCommand("%临界推演排名")).toEqual({ kind: "board", mode });
  expect(rankCommand("/zzz推演排名")).toEqual({ kind: "board", mode });
  expect(rankCommand("%显示临界群内排名2")).toEqual({ kind: "visibility", types: [mode], enabled: true, profileId: 2 });
  expect(rankCommand("%隐藏推演排名")).toEqual({ kind: "visibility", types: [mode], enabled: false, profileId: 1 });
  expect(rankCommand("%往期临界排名")).toBeUndefined();
  const record = snapshot(0);
  const row = rankRow(mode, profile, record, phase, "legacy")!;
  expect(row).toMatchObject({ score: 0, latest: phase - 4000, expiresAt: rankEndsAt,
    voidFront: { finalStage: { rating: "SP" }, stages: [{ rating: "AP" }] } });
  expect(rankRow(mode, profile, snapshot(1, false), phase, "current")).toBeUndefined();
  expect(rankRow(mode, profile, { ...record, scheduleType: 2 }, phase, "current")).toBeUndefined();
  expect(rankRow(mode, profile, { ...record, rankEndsAt: undefined }, phase, "current")).toBeUndefined();
  expect(rankRow(mode, profile, { ...record, finalStage: undefined }, phase, "current")).toBeUndefined();
  expect(rankRow(mode, profile, { ...record, stages: [{ ...record.stages[0]!, clearedAt: undefined }] }, phase, "current")).toBeUndefined();
  expect(rankRow(mode, profile, record, rankEndsAt + 1, "current")).toBeUndefined();
  expect(sortedRankRows(mode, [
    { ...row, nickname: "高分", score: 1 },
    { ...row, nickname: "平分较晚", latest: phase - 3000 },
    { ...row, nickname: "平分较早" },
  ]).map(item => item.nickname)).toEqual(["高分", "平分较早", "平分较晚"]);
});

test.skipIf(!valkey)("临界分模式保存最后一次本期记录，旧授权和拟境开关都不能替代本人临界授权", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-void-rank-"));
  const monitor = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = monitor.port;
  monitor.stop(true);
  const password = crypto.randomUUID();
  const server = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", root], { stdout: "pipe", stderr: "ignore" });
  try {
    const reader = server.stdout.getReader();
    let output = "";
    while (!output.includes("Ready to accept connections")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("隔离存储初始化失败。");
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const redis = await connectStorage(`redis://:${password}@127.0.0.1:${port}`);
    await mkdir(join(root, "voidFrontBattle"));
    const path = join(root, "voidFrontBattle", profile.uid + ".json");
    const bytes = JSON.stringify({ player: { player: { game_uid: profile.uid, region: profile.region, nickname: "合成旧档",
      game_biz: "nap_cn" } }, result: source(620000) });
    await writeFile(path, bytes);
    await redis.set(old, "1");
    await redis.set(oldOwner, "1");
    const store = createChallengeRankStore(redis, root);
    const members = new Set(["42", "43"]);
    const rows = (scope = group, present = members) => store.rows(scope, mode, present, Date.now());
    const holo = normalizeZzzHoloBoss({ unlock: true, start_time: wall(phase - 10000), end_time: wall(rankEndsAt),
      list: [{ star: 4, challenge_time: { minute: 1, second: 0 } }] }, { ...profile, scheduleType: 1 });
    await store.setVisibility(group, ["HOLO_BOSS"], profile.uid, profile.region, true, profile);
    await store.remember(group, "HOLO_BOSS", profile, holo, 4);
    expect(await rows()).toEqual([]);
    expect(await store.remember(group, mode, profile, snapshot(633000), 5)).toBe(false);
    expect(await redis.hGet(`${modern}:records`, field)).toBeNull();
    await store.setVisibility(group, [mode], profile.uid, profile.region, true, profile);
    await store.setVisibility(other, [mode], profile.uid, profile.region, true, profile);
    expect(await rows(other)).toEqual([]);
    expect(await rows(group, new Set(["43"]))).toEqual([]);
    const legacy = await rows();
    expect(legacy[0]).toMatchObject({ score: 620000, source: "legacy", profileId: 2 });
    expect(await store.stillVisible(group, mode, members, legacy, Date.now())).toBe(true);
    await store.remember(group, mode, profile, snapshot(615000), 6);
    expect((await rows())[0]).toMatchObject({ source: "current", score: 615000 });
    expect(await store.stillVisible(group, mode, members, legacy, Date.now())).toBe(false);
    await Promise.all([store.remember(group, mode, profile, snapshot(570000), 9),
      store.remember(group, mode, profile, snapshot(635000), 8)]);
    const ranked = await rows();
    expect(ranked[0]).toMatchObject({ score: 570000 });
    expect(await store.remember(group, mode, profile, { ...snapshot(660000), scheduleType: 2 }, 10)).toBeUndefined();
    expect((await rows())[0]).toMatchObject({ score: 570000 });
    await store.remember(group, mode, profile, snapshot(0, false), 11);
    expect(await store.stillVisible(group, mode, members, ranked, Date.now())).toBe(false);
    expect(await rows()).toEqual([]);
    await store.setVisibility(group, [mode], profile.uid, profile.region, false, profile);
    expect((await store.rows(group, "HOLO_BOSS", members, Date.now()))[0]?.bonus).toBe(4);
    expect(await redis.get(old)).toBe("1");
    expect(await redis.get(oldOwner)).toBe("1");
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    await closeStorage();
    server.kill();
    await server.exited;
    await rm(root, { recursive: true, force: true });
  }
});
