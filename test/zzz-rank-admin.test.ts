import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { normalizeZzzShiyu } from "@lotus-yunzai/hoyo-client";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { rankCommand } from "../plugins/zzz/challenge-rank-model.ts";
import { createChallengeRankStore, parseRankConfig, readRankConfig } from "../plugins/zzz/challenge-rank-store.ts";
import { createZzzChallengeRanks } from "../plugins/zzz/challenge-rank.ts";

test("主人群榜开关仅用已注册的旧别名，清空限定本群式舆", () => {
  expect(rankCommand("%关闭群内深渊排名")).toEqual({ kind: "admin-toggle", enabled: false });
  expect(rankCommand("/zzzON群强袭战排名")).toEqual({ kind: "admin-toggle", enabled: true });
  expect(rankCommand("%停止群临界排名")).toEqual({ kind: "admin-toggle", enabled: false });
  expect(rankCommand("%关闭群拟境排名")).toBeUndefined();
  expect(rankCommand("%重置防卫排名")).toEqual({ kind: "admin-clear" });
  expect(rankCommand("%清空式舆防卫战排名")).toEqual({ kind: "admin-clear" });
  expect(rankCommand("%重置危局排名")).toBeUndefined();
  expect(rankCommand("%清空临界排名")).toBeUndefined();
  expect(rankCommand("%显示深渊群内排名")).toMatchObject({ kind: "visibility" });

  const config = { allow_group: true, white_list: [78], black_list: [79], max_display: 7 };
  expect(parseRankConfig(config, "77", false)).toEqual({ allowed: false, maximum: 7 });
  expect(parseRankConfig(config, "78", false)).toEqual({ allowed: true, maximum: 7 });
  expect(parseRankConfig(config, "79", true)).toEqual({ allowed: false, maximum: 7 });
});

const executable = Bun.which("valkey-server");
const profile = { qq: "42", profileId: 1, uid: "12345678", region: "prod_gf_cn", nickname: "合成绳匠" } as const;
const field = "prod_gf_cn:12345678";
const period = { year: 2026, month: 11, day: 20, hour: 0, minute: 0, second: 0 };
const now = Date.parse("2026-11-21T00:00:00+08:00");
const raw = (score: number) => ({ hadal_ver: "v2", hadal_info_v2: {
  hadal_begin_time: period, hadal_end_time: { ...period, day: 30 }, brief: { score, rating: "S+" },
  fitfh_layer_detail: { layer_challenge_info_list: [{ score, avatar_list: [], challenge_time: period }] },
} });
const snapshot = (score: number) => normalizeZzzShiyu(raw(score), { ...profile, scheduleType: 1 });

test.skipIf(!executable)("主人撤权及时拦截，ABYSS 新代屏蔽旧档和迟到写入且保留其他键", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-rank-admin-"));
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  const secret = crypto.randomUUID();
  const child = Bun.spawn([executable!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", secret,
    "--save", "", "--appendonly", "no", "--dir", root], { stdout: "pipe", stderr: "ignore" });
  const oldRedis = globalThis.redis;
  const configVariable = Bun.env.LOTUS_ZZZ_RANK_CONFIG;
  try {
    const reader = child.stdout.getReader();
    let buffer = "";
    while (!buffer.includes("Ready to accept connections")) {
      const item = await reader.read();
      if (item.done) throw Error("隔离 Valkey 启动失败。");
      buffer += new TextDecoder().decode(item.value);
    }
    reader.releaseLock();
    const redis = await connectStorage(`redis://:${secret}@127.0.0.1:${port}`);
    globalThis.redis = redis;
    const config = join(root, "rank.yaml");
    const yaml = "allow_group: true\nwhite_list: [78]\nblack_list: [79]\nmax_display: 7\n";
    await writeFile(config, yaml);
    Bun.env.LOTUS_ZZZ_RANK_CONFIG = config;
    await mkdir(join(root, "abyss"));
    const oldFile = join(root, "abyss", "12345678.json");
    const bytes = JSON.stringify({ player: { player: { game_uid: "12345678", region: "prod_gf_cn", game_biz: "nap_cn" } }, result: raw(150000) });
    await writeFile(oldFile, bytes);
    const oldKeys = ["ZZZ:RANK:ABYSS:77:12345678", "ZZZ:RANK:ABYSS:78:12345678", "ZZZ:RANK:UID2QQS:77:12345678:42", "ZZZ:RANK:UID2QQS:78:12345678:42"];
    for (const key of oldKeys) await redis.set(key, "1");
    const otherMode = "lotus-yunzai:zzz-challenge-ranks:77:DEADLY:records";
    const original = "lotus-yunzai:zzz-challenge-ranks:77:ABYSS:records";
    const visibility = "lotus-yunzai:zzz-challenge-ranks:77:ABYSS:visibility";
    await redis.hSet(otherMode, "metadata", "未知字段");
    await redis.hSet(original, "metadata", "原字段");
    let store = createChallengeRankStore(redis, root);
    const members = new Set(["42"]);
    const first = await store.rows("77", "ABYSS", members, now);
    expect(first[0]?.score).toBe(150000);
    expect(await store.generation("77", "ABYSS")).toBeNull();
    await store.remember("77", "ABYSS", profile, snapshot(160000), 2);
    const seed = await redis.hGet(original, field);
    expect(seed).toBeTruthy();

    const commands = createZzzChallengeRanks(createProfileStore(root), new AbortController().signal);
    let owner = true, revoke = false;
    const context = { adapter: "milky", message_type: "group", group_id: 77, user_id: 42, isMaster: false,
      isBotMaster: () => owner, async listCheckinGroupMembers() { if (revoke) owner = false; return [{ id: 42 }]; },
    };
    const clear = { kind: "admin-clear" } as const;
    expect(await commands.handle({ ...context, isDelegated: true }, clear)).toContain("群聊");
    expect(await commands.handle({ ...context, message_type: "private" }, clear)).toContain("群聊");
    revoke = true;
    expect(await commands.handle(context, clear)).toContain("仅限主人");
    expect(await store.generation("77", "ABYSS")).toBeNull();
    owner = true;
    revoke = false;
    expect(await commands.handle(context, { kind: "admin-toggle", enabled: false })).toContain("白名单");
    expect(await readRankConfig("77")).toEqual({ allowed: false, maximum: 7 });
    expect(await readRankConfig("78")).toEqual({ allowed: true, maximum: 7 });
    expect(await commands.handle(context, clear)).toContain("已清空本群式舆");
    const generation = await store.generation("77", "ABYSS");
    expect(generation).toBeTruthy();
    expect(await store.generation("78", "ABYSS")).toBeNull();
    expect(await store.rows("77", "ABYSS", members, now)).toEqual([]);
    expect(await store.stillVisible("77", "ABYSS", members, first, now)).toBe(false);
    expect(await store.remember("77", "ABYSS", profile, snapshot(200000), 3, null)).toBe(false);
    expect(await redis.hGet(original, field)).toBe(seed);
    expect(await redis.hGet(original, "metadata")).toBe("原字段");
    expect(await redis.hGet(otherMode, "metadata")).toBe("未知字段");
    expect(await redis.hGet(visibility, field)).toBe("1");

    store = createChallengeRankStore(redis, root);
    expect(await store.generation("77", "ABYSS")).toBe(generation);
    expect(await store.rows("77", "ABYSS", members, now)).toEqual([]);
    expect((await store.rows("78", "ABYSS", members, now))[0]?.score).toBe(150000);
    expect(await store.remember("77", "ABYSS", profile, snapshot(210000), 4, generation)).toBe(true);
    const fresh = await store.rows("77", "ABYSS", members, now);
    expect(fresh[0]?.score).toBe(210000);
    expect(await store.stillVisible("77", "ABYSS", members, fresh, now, generation)).toBe(true);
    await commands.handle(context, clear);
    expect(await store.stillVisible("77", "ABYSS", members, fresh, now, generation)).toBe(false);
    expect(await store.remember("77", "ABYSS", profile, snapshot(300000), 5, generation)).toBe(false);
    expect(await store.rows("77", "ABYSS", members, now)).toEqual([]);
    expect(await redis.mGet(oldKeys)).toEqual(["1", "1", "1", "1"]);
    expect(await readFile(config, "utf8")).toBe(yaml);
    expect(await readFile(oldFile, "utf8")).toBe(bytes);
  } finally {
    globalThis.redis = oldRedis;
    if (configVariable === undefined) delete Bun.env.LOTUS_ZZZ_RANK_CONFIG;
    else Bun.env.LOTUS_ZZZ_RANK_CONFIG = configVariable;
    await closeStorage();
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
