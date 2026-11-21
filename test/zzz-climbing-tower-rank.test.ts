import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeZzzClimbingTower } from "@lotus-yunzai/hoyo-client";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { rankCommand, rankRow, sortedRankRows, towerRanks } from "../plugins/zzz/challenge-rank-model.ts";
import { createChallengeRankStore } from "../plugins/zzz/challenge-rank-store.ts";

const valkey = Bun.which("valkey-server");
const profile = { qq: "42", profileId: 2, uid: "12345678", region: "prod_gf_cn", nickname: "合成会员" } as const;
const [s3, s4] = towerRanks;
const group = "77";
const field = "prod_gf_cn:12345678";
const oldOwner = `ZZZ:RANK:UID2QQS:${group}:${profile.uid}:${profile.qq}`;
const oldKey = (type: typeof s3 | typeof s4) => `ZZZ:RANK:${type}:${group}:${profile.uid}`;
const current = (type: typeof s3 | typeof s4) => `lotus-yunzai:zzz-challenge-ranks:${group}:${type}:records`;
const season = (score: number, floor = 0, noDamage = 0) => ({
  layer_info: { total_score: score, climbing_tower_layer: floor }, mvp_info: { floor_mvp_num: noDamage, rank_percent: 9300 },
  display_avatar_rank_list: [{ name: "仅本人可见的合成代理人", score: 500 }],
});
const snapshot = (third?: number, fourth?: number) => normalizeZzzClimbingTower({
  climbing_tower_s3: third === undefined ? undefined : season(third),
  climbing_tower_s4: fourth === undefined ? undefined : season(fourth),
}, profile);

test("爬塔 S3 和 S4 命令独立，完整的零分也按总分、层数、无伤排序", () => {
  expect(rankCommand("%爬塔排名")).toEqual({ kind: "tower-help" });
  expect(rankCommand("%爬塔s3排名")).toEqual({ kind: "board", mode: s3 });
  expect(rankCommand("/zzz鏖战试炼:狂澜排名")).toEqual({ kind: "board", mode: s4 });
  expect(rankCommand("%显示爬塔S3群内排名2")).toEqual({ kind: "visibility", enabled: true, profileId: 2, types: [s3] });
  expect(rankCommand("%取消显示鏖战试炼：狂澜排名")).toEqual({ kind: "visibility", enabled: false, profileId: 1, types: [s4] });
  expect(rankCommand("%爬塔S1排名")).toBeUndefined();
  const record = snapshot(0, 100);
  const row = rankRow(s3, profile, record, Date.now(), "current")!;
  expect(row).toMatchObject({ score: 0, tower: { layer: 0, noDamage: 0 } });
  expect(rankRow(s4, profile, record, Date.now(), "current")?.score).toBe(100);
  expect(rankRow(s4, profile, snapshot(13), Date.now(), "current")).toBeUndefined();
  expect(rankRow(s3, profile, normalizeZzzClimbingTower({ climbing_tower_s3: { layer_info: { total_score: 170 } } }, profile),
    Date.now(), "current")).toBeUndefined();
  expect(sortedRankRows(s3, [
    { ...row, nickname: "低分高层", tower: { layer: 9, noDamage: 40 } },
    { ...row, nickname: "高分低层", score: 10 },
    { ...row, nickname: "同分少层", score: 10, tower: { layer: 2, noDamage: 9 } },
    { ...row, nickname: "同层多无伤", score: 10, tower: { layer: 2, noDamage: 10 } },
  ]).map(item => item.nickname)).toEqual(["同层多无伤", "同分少层", "高分低层", "低分高层"]);
});

test.skipIf(!valkey)("两季 Valkey 按本群本人显式授权分写，源旧缓存保持，个人代理人不落群榜", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-tower-rank-"));
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
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
    await mkdir(join(root, "climbingTower"));
    const path = join(root, "climbingTower", profile.uid + ".json");
    const bytes = JSON.stringify({ player: { player: { game_uid: profile.uid, region: profile.region, nickname: "合成旧档",
      game_biz: "nap_cn" } }, result: { climbing_tower_s3: season(200, 20, 5), climbing_tower_s4: season(350, 40, 10),
      climbing_tower_s1: "旧整档里与 S3 S4 无关的不合法内容" } });
    await writeFile(path, bytes);
    await redis.set(oldKey(s3), "1");
    await redis.set(oldKey(s4), "1");
    await redis.set(oldOwner, "1");
    const store = createChallengeRankStore(redis, root);
    const members = new Set(["42", "43"]);
    const rows = (type: typeof s3 | typeof s4, scope = group) => store.rows(scope, type, members, Date.now());

    expect(await rows(s3)).toEqual([]);
    expect(await store.remember(group, s3, profile, snapshot(80, 700), 1)).toBe(false);
    await store.setVisibility(group, [s3], profile.uid, profile.region, true, profile);
    const oldRows = await rows(s3);
    expect(oldRows[0]).toMatchObject({ source: "legacy", score: 200 });
    expect(await rows(s4)).toEqual([]);
    expect(await rows(s3, "78")).toEqual([]);
    await store.remember(group, s3, profile, snapshot(88, 770), 2);
    expect((await rows(s3))[0]).toMatchObject({ source: "current", score: 88 });
    const payload = JSON.parse((await redis.hGet(current(s3), field))!);
    expect(payload.snapshot.seasons).toEqual([{ number: 3, layer: 0, mvp: 0, score: 88, avatars: [] }]);
    expect(await redis.hGet(current(s4), field)).toBeNull();
    expect(await store.stillVisible(group, s3, members, oldRows, Date.now())).toBe(false);
    await store.setVisibility(group, [s4], profile.uid, profile.region, true, profile);
    expect((await rows(s4))[0]?.score).toBe(350);
    await store.remember(group, s4, profile, snapshot(80, 700), 3);
    expect((await rows(s4))[0]).toMatchObject({ source: "current", score: 700 });
    await Promise.all([store.remember(group, s3, profile, snapshot(57), 5), store.remember(group, s3, profile, snapshot(99), 4)]);
    expect((await rows(s3))[0]?.score).toBe(57);
    expect(await store.remember(group, s4, profile, snapshot(57), 5)).toBeUndefined();
    expect((await rows(s4))[0]?.score).toBe(700);
    await store.setVisibility(group, [s3], profile.uid, profile.region, false, profile);
    expect(await rows(s3)).toEqual([]);
    expect((await rows(s4))[0]?.score).toBe(700);
    expect(await redis.get(oldKey(s3))).toBe("1");
    expect(await redis.get(oldKey(s4))).toBe("1");
    expect(await redis.get(oldOwner)).toBe("1");
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    await closeStorage();
    server.kill();
    await server.exited;
    await rm(root, { recursive: true, force: true });
  }
});
