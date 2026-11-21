import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeZzzHoloBoss } from "@lotus-yunzai/hoyo-client";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { createChallengeRankStore } from "../plugins/zzz/challenge-rank-store.ts";

const valkey = Bun.which("valkey-server");
const profile = { qq: "42", profileId: 2, uid: "12345678", region: "prod_gf_cn", nickname: "合成会员" } as const;
const mode = "HOLO_BOSS";
const group = "77";
const other = "78";
const field = "prod_gf_cn:12345678";
const old = `ZZZ:RANK:${mode}:${group}:${profile.uid}`;
const oldOwner = `ZZZ:RANK:UID2QQS:${group}:${profile.uid}:${profile.qq}`;
const modern = `lotus-yunzai:zzz-challenge-ranks:${group}:${mode}`;

function time(hours: number) {
  const d = new Date(Date.now() + (hours + 8) * 3_600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours() };
}

test.skipIf(!valkey)("拟境榜只收本群本人显式授权，保留原档并原子选择当期最好记录", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-holo-rank-"));
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
    const source = (star: number, seconds: number, undamaged = false) => ({
      uid: profile.uid, region: profile.region, unlock: true, start_time: time(-24), end_time: time(24),
      list: [{ star, challenge_time: { minute: 0, second: seconds },
        boss: { name: "合成首领", medal: { is_no_injured: undamaged } } }],
    });
    const snapshot = (star: number, seconds: number, undamaged = false) =>
      normalizeZzzHoloBoss(source(star, seconds, undamaged), { ...profile, scheduleType: 1 });
    await mkdir(join(root, "holoBoss"));
    const path = join(root, "holoBoss", profile.uid + ".json");
    const bytes = JSON.stringify({ player: { player: { game_uid: profile.uid, region: profile.region, nickname: "合成旧档",
      game_biz: "nap_cn" } }, result: source(4, 20), updateTime: Math.floor(Date.now() / 1000) - 60 });
    await writeFile(path, bytes);
    await redis.set(old, "1");
    await redis.set(oldOwner, "1");
    const store = createChallengeRankStore(redis, root);
    const members = new Set(["42", "43"]);
    const rows = (scope = group, present = members) => store.rows(scope, mode, present, Date.now());

    expect(await rows()).toEqual([]);
    expect(await store.remember(group, mode, profile, snapshot(4, 19), Date.now())).toBe(false);
    expect(await redis.hGet(`${modern}:records`, field)).toBeNull();
    expect(await store.setVisibility(group, [mode], profile.uid, profile.region, true)).toBe(false);
    await store.setVisibility(group, [mode], profile.uid, profile.region, true, profile);
    await store.setVisibility(other, [mode], profile.uid, profile.region, true, profile);
    expect(await rows(other)).toEqual([]);
    expect(await rows(group, new Set(["43"]))).toEqual([]);
    const [legacy] = await rows();
    expect(legacy).toMatchObject({ source: "legacy", profileId: 2, score: 20, nickname: "合成旧档" });
    expect(await store.remember(group, mode, { ...profile, qq: "43" }, snapshot(4, 16), Date.now())).toBe(false);
    expect(await store.remember(group, mode, profile, { ...snapshot(4, 16), scheduleType: 2 }, Date.now())).toBeUndefined();
    await store.remember(group, mode, profile, snapshot(4, 25), Date.now());
    expect((await rows())[0]?.source).toBe("legacy");
    await Promise.all([store.remember(group, mode, profile, snapshot(4, 18), Date.now()),
      store.remember(group, mode, profile, snapshot(4, 17), Date.now()),
      store.remember(group, mode, profile, snapshot(4, 17, true), Date.now())]);
    expect((await rows())[0]).toMatchObject({ source: "current", score: 17, holo: { undamaged: 1 } });
    await store.remember(group, mode, profile, snapshot(4, 17), Date.now());
    const ranked = await rows();
    expect(ranked[0]).toMatchObject({ score: 17, holo: { undamaged: 1 } });
    expect(await store.stillVisible(group, mode, members, ranked, Date.now())).toBe(true);
    await store.setVisibility(group, [mode], profile.uid, profile.region, false, profile);
    expect(await store.stillVisible(group, mode, members, ranked, Date.now())).toBe(false);
    expect(await rows()).toEqual([]);
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
