import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createProfileStore } from "../packages/account/index.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { createStarRailGachaHistoryStore } from "../plugins/starrail/gacha-store.ts";
import { createStarRailGachaSync } from "../plugins/starrail/gacha-sync.ts";

const qq = "42";
const uid = "512345678";
const initialProfile = `
version: 1
user: { qq: "${qq}" }
profile: { id: 2 }
account:
  cookie: "cookie_token=old-cookie"
  stoken: mock-stoken
  stuid: "42"
  game_roles:
    sr: [{ game_uid: "${uid}", game_biz: hkrpg_cn }]
  current_uid: { sr: "${uid}" }
device: { id: fixture-device }
`;
const firstId = "1735853810000001901";
const secondId = "1735853810000001902";
const oldId = "1735553810000001900";
const legacyHistory = JSON.stringify({
  version: 1, qq, uid, region: "prod_qd_cn", profileId: 2,
  pools: {
    GachaType_AvatarUp: {
      name: "角色活动跃迁", cards: [{ gacha_id: "old-period", total_count: 30 }],
      totalDraws: 30, pity: 3,
      fiveStars: [{ id: oldId, item: { item_id: 1020 }, gacha_count: 21, is_up: false }],
    },
  },
});

async function withFixture(
  operation: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "lotus-sr-history-"));
  try {
    await operation(await makeFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeFixture(root: string) {
  const accountDir = join(root, "profiles");
  const historyDir = join(root, "starRailGachaJson");
  const profileFile = join(accountDir, "42-2.yaml");
  const file = join(historyDir, qq, `${uid}.json`);
  await mkdir(accountDir);
  await writeFile(profileFile, initialProfile);
  const profiles = createProfileStore(accountDir);
  const history = createStarRailGachaHistoryStore(historyDir, lockFile);
  return { root, profiles, profileFile, history, historyDir, file };
}

async function seed(file: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, legacyHistory, { mode: 0o640 });
}

function mockedClient(
  profiles: ReturnType<typeof createProfileStore>,
  { id = firstId, total = 60, fails = false, expires = false } = {},
) {
  let refreshes = 0;
  const client = createHoyoClient(async (url, init) => {
    const endpoint = url.pathname.split("/").at(-1)!;
    const pool = url.searchParams.get("gacha_type");
    if (endpoint === "account") {
      if (expires && new Headers(init.headers).get("Cookie")?.includes("old-cookie")) {
        return Response.json({ retcode: -100 });
      }
      return Response.json({ retcode: 0 }, { headers: { "Set-Cookie": "e_hkrpg_token=fixture-activity; Secure" } });
    }
    if (endpoint === "brief") return Response.json({ retcode: 0, data: { items: [] } });
    const avatar = pool === "GachaType_AvatarUp";
    if (endpoint === "pool_stat") {
      return Response.json({ retcode: 0, data: { cards: avatar ? [{ gacha_id: "current-period", total_count: total }] : [] } });
    }
    if (fails && pool === "GachaType_Newbie") return Response.json({ retcode: 0, data: { list: [] } });
    return Response.json({
      retcode: 0, data: { list: avatar ? [{ id, item: { item_id: 1100 }, gacha_count: 40 }] : [], has_more: false },
    });
  }, {
    profiles,
    async exchange() {
      refreshes++;
      return { cookie: "cookie_token=new-cookie", ltoken: "fixture-new-ltoken" };
    },
  });
  return { client, refreshes: () => refreshes };
}

test("用实际客户端和文件锁同步 v1 历史，两个实例并行保留各自记录，重跑不累计", async () => {
  await withFixture(async ({ profiles, history, historyDir, file }) => {
    await seed(file);
    expect(await history.read(qq, uid)).toEqual(JSON.parse(legacyHistory));
    const ready = Promise.withResolvers<void>();
    let contenders = 0;
    const acquire = async (path: string, subject: string) => {
      if (++contenders === 2) ready.resolve();
      await ready.promise;
      return lockFile(path, subject);
    };
    const serviceA = createStarRailGachaSync(profiles, mockedClient(profiles).client,
      createStarRailGachaHistoryStore(historyDir, acquire));
    const serviceB = createStarRailGachaSync(profiles, mockedClient(profiles, { id: secondId, total: 65 }).client,
      createStarRailGachaHistoryStore(historyDir, acquire));
    const complete = await Promise.all([
      serviceA.sync(qq, 2, { intervalMs: 0 }), serviceB.sync(qq, 2, { intervalMs: 0 }),
    ]);
    expect(complete.map(({ added }) => added)).toEqual([1, 1]);
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.pools.GachaType_AvatarUp).toMatchObject({
      fiveStars: [{ id: secondId }, { id: firstId }, { id: oldId }],
      totalDraws: 95, cardCounters: { "old-period": 30, "current-period": 65 }, pity: 3,
    });
    const again = await serviceA.sync(qq, 2, { intervalMs: 0 });
    expect(again).toMatchObject({ added: 0, total: 3 });
    expect(again.log.pools.GachaType_AvatarUp.totalDraws).toBe(95);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(await readdir(dirname(file))).not.toContainEqual(expect.stringMatching(/^\.lotus-gacha-write-/u));
  });
});

test("完整六池和刷新后的有效档案才建立历史，末池出错不触碰旧文件", async () => {
  await withFixture(async ({ profiles, history, file }) => {
    expect(await history.read(qq, uid)).toBeNull();
    const incomplete = createStarRailGachaSync(profiles, mockedClient(profiles, { fails: true }).client, history);
    await expect(incomplete.sync(qq, 2, { intervalMs: 0 })).rejects.toMatchObject({ code: "response" });
    expect(await history.read(qq, uid)).toBeNull();

    const expired = mockedClient(profiles, { expires: true });
    const refreshable = createStarRailGachaSync(profiles, expired.client, history);
    const created = await refreshable.sync(qq, 2, { intervalMs: 0 });
    expect(created).toMatchObject({ added: 1, total: 1, refreshedCookie: true });
    expect(expired.refreshes()).toBe(1);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(file, "utf8");
    expect(bytes).not.toContain("fixture-activity");
    expect(bytes).not.toContain("new-cookie");
    await expect(incomplete.sync(qq, 2, { intervalMs: 0 })).rejects.toMatchObject({ code: "response" });
    expect(await readFile(file, "utf8")).toBe(bytes);
  });
});

test("历史暂存后账号换绑中止替换，旧文件原样保留", async () => {
  await withFixture(async ({ profiles, profileFile, history, file }) => {
    await seed(file);
    let rebound = false;
    const watchedProfiles = {
      async requestContext(...args: Parameters<typeof profiles.requestContext>) {
        if (!rebound && (await readdir(dirname(file))).some((name) => name.startsWith(".lotus-gacha-write-"))) {
          rebound = true;
          await writeFile(profileFile, initialProfile.replace("mock-stoken", "rebound-token"));
        }
        return profiles.requestContext(...args);
      },
    };
    const service = createStarRailGachaSync(watchedProfiles, mockedClient(profiles).client, history);
    await expect(service.sync(qq, 2, { intervalMs: 0 })).rejects.toMatchObject({ code: "changed" });
    expect(rebound).toBe(true);
    expect(await readFile(file, "utf8")).toBe(legacyHistory);
    expect(await readdir(dirname(file))).not.toContainEqual(expect.stringMatching(/^\.lotus-gacha-write-/u));
  });
});

test("旧进程在最终档案核验时改写历史则保留该写入", async () => {
  await withFixture(async ({ profiles, history, file }) => {
    await seed(file);
    const externalWrite = JSON.stringify({ ...JSON.parse(legacyHistory), writtenExternally: true });
    let wrote = false;
    const watchedProfiles = {
      async requestContext(...args: Parameters<typeof profiles.requestContext>) {
        if (!wrote && (await readdir(dirname(file))).some((name) => name.startsWith(".lotus-gacha-write-"))) {
          wrote = true;
          await writeFile(file, externalWrite);
        }
        return profiles.requestContext(...args);
      },
    };
    const service = createStarRailGachaSync(watchedProfiles, mockedClient(profiles).client, history);
    await expect(service.sync(qq, 2, { intervalMs: 0 })).rejects.toThrow("历史已变更");
    expect(wrote).toBe(true);
    expect(await readFile(file, "utf8")).toBe(externalWrite);
  });
});

test("拒绝符号链接的 QQ 目录与历史文件，保留损坏的旧 JSON", async () => {
  await withFixture(async ({ profiles, history, historyDir, root, file }) => {
    const service = createStarRailGachaSync(profiles, mockedClient(profiles).client, history);
    const external = join(root, "external");
    await mkdir(external);
    await mkdir(historyDir);
    await symlink(external, dirname(file));
    await expect(service.sync(qq, 2, { intervalMs: 0 })).rejects.toThrow("QQ 目录须为实际目录");
    expect(await readdir(external)).toEqual([]);
    await rm(dirname(file), { force: true });
    await mkdir(dirname(file));
    const target = join(external, "history.json");
    await writeFile(target, legacyHistory);
    await symlink(target, file);
    await expect(service.sync(qq, 2, { intervalMs: 0 })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(legacyHistory);
    await rm(file);
    await writeFile(file, "{损坏: true}");
    await expect(service.sync(qq, 2, { intervalMs: 0 })).rejects.toThrow("JSON 格式无效");
    expect(await readFile(file, "utf8")).toBe("{损坏: true}");
  });
});

test("同 QQ 同 UID 的两个档号只启动一轮，失败后释放", async () => {
  await withFixture(async ({ profiles, history, profileFile, file }) => {
    await writeFile(profileFile.replace("-2.yaml", ".yaml"), initialProfile.replace("id: 2", "id: 1"));
    const credentialUp = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const valid = mockedClient(profiles).client;
    let calls = 0;
    const client = { async fetchStarRailGacha(...args: Parameters<typeof valid.fetchStarRailGacha>) {
      if (++calls === 1) {
        credentialUp.resolve();
        await release.promise;
        throw Error("隔离请求失败");
      }
      return valid.fetchStarRailGacha(...args);
    } };
    const service = createStarRailGachaSync(profiles, client, history);
    const first = service.sync(qq, 1, { intervalMs: 0 });
    const failure = first.catch(error => error);
    try {
      await Promise.race([credentialUp.promise, first]);
      await expect(service.sync(qq, 2, { intervalMs: 0 })).rejects.toThrow("该账号的星铁抽卡记录正在更新");
      expect(calls).toBe(1);
    } finally { release.resolve(); }
    expect(await failure).toMatchObject({ message: "隔离请求失败" });
    expect(await history.read(qq, uid)).toBeNull();
    expect(await service.sync(qq, 2, { intervalMs: 0 })).toMatchObject({ added: 1 });
    expect(await Bun.file(file).exists()).toBe(true);
    expect(calls).toBe(2);
  });
});
