import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { importWorldBossRanking } from "../plugins/genshin/world-boss-ranking-import.ts";
import { createGenshinWorldBossRanking } from "../plugins/genshin/world-boss-ranking.ts";

const grant = { qq: "42", profileId: 2, uid: "123456789", region: "cn_gf01" };
const differentUid = "223456789";
const legacy = {
  [grant.uid]: [{ name: "急冻树", kill_num: 8, icon: "https://fixture.invalid/do-not-store" }],
  [differentUid]: [{ name: "无相之岩", kill_num: 900 }],
};
const profile = {
  version: 1, user: { qq: grant.qq }, profile: { id: grant.profileId },
  account: {
    cookie: "ltoken=fixture-dont-export", stoken: "fixture-session",
    game_roles: { gs: [
      { uid: differentUid, region: "cn_gf01", game_biz: "hk4e_cn" },
      { uid: grant.uid, region: grant.region, game_biz: "hk4e_cn" },
    ] },
    current_uid: { gs: differentUid },
  },
};

async function fixture(run: (input: Parameters<typeof importWorldBossRanking>[0], profileFile: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-legacy-boss-import-"));
  const sourceFile = join(directory, "old.json");
  const authorizationFile = join(directory, "authorization.json");
  const profileDirectory = join(directory, "profiles");
  const destinationDirectory = join(directory, "summary");
  const profileFile = join(profileDirectory, `${grant.qq}-${grant.profileId}.yaml`);
  try {
    await mkdir(profileDirectory);
    await writeFile(sourceFile, JSON.stringify(legacy));
    await writeFile(authorizationFile, JSON.stringify({ version: 1, roles: [grant] }));
    await writeFile(profileFile, Bun.YAML.stringify(profile));
    await run({ sourceFile, authorizationFile, profileDirectory, destinationDirectory }, profileFile);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("CLI 预检无写入，只导入明确授权的已绑定角色且可逐字节重跑", () => fixture(async (input) => {
  async function cli(apply = false) {
    const path = new URL("../scripts/import-world-boss-ranking.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, path, ...(apply ? ["--apply"] : []), input.sourceFile,
      input.authorizationFile, input.profileDirectory, input.destinationDirectory], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(grant.uid);
    return JSON.parse(stdout);
  }

  expect(await cli()).toMatchObject({ mode: "dry-run", ready: 1, imported: 0, unauthorized: 1 });
  await expect(lstat(input.destinationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await cli(true)).toMatchObject({ mode: "apply", ready: 0, imported: 1, unauthorized: 1 });
  const document = join(input.destinationDirectory, grant.qq, `${grant.uid}.json`);
  const [bytes, identity] = await Promise.all([readFile(document, "utf8"), lstat(document)]);
  const decoded: Record<string, unknown> = JSON.parse(bytes);
  expect(decoded).toMatchObject({ origin: "legacy", bosses: [{ name: "急冻树", killCount: 8 }] });
  expect(decoded).not.toHaveProperty("observedAt");
  expect(bytes).not.toContain("fixture");
  expect(identity.mode & 0o777).toBe(0o600);
  expect(await cli(true)).toMatchObject({ unchanged: 1, imported: 0 });
  expect(await readFile(document, "utf8")).toBe(bytes);
  expect((await lstat(document)).ino).toBe(identity.ino);
  expect(JSON.parse(await readFile(input.sourceFile, "utf8"))).toEqual(legacy);
}));

test("任何新版同 UID 快照优先于旧历史，包含跨 QQ 与后来写入的空榜", () => fixture(async (input) => {
  const store = createGenshinWorldBossRanking(input.destinationDirectory, lockFile);
  const apply = { ...input, apply: true };
  expect(await importWorldBossRanking(apply, lockFile)).toMatchObject({ imported: 1 });
  expect(await store.rank()).toEqual([{ uid: grant.uid, name: "急冻树", killCount: 8 }]);
  const live = { ...grant, qq: "900" };
  const snapshot = { uid: grant.uid, region: grant.region, status: "available" as const, groups: [] };
  await store.record(live, snapshot, 1, async () => {});
  expect(await store.rank()).toEqual([]);
  expect(await importWorldBossRanking(apply, lockFile)).toMatchObject({ unchanged: 1 });
  await store.record(grant, snapshot, 1, async () => {});
  expect(await importWorldBossRanking(apply, lockFile)).toMatchObject({ protected: 1 });
  expect(await store.rank()).toEqual([]);
}));

test("冲突、无档案或写入前换绑不会改写摘要", () => fixture(async (input, profileFile) => {
  const apply = { ...input, apply: true };
  const changedBeforeLock: typeof lockFile = async (...args) => {
    await writeFile(profileFile, Bun.YAML.stringify({ ...profile, profile: { ...profile.profile, name: "档案已变更" } }));
    return lockFile(...args);
  };
  expect(await importWorldBossRanking(apply, changedBeforeLock)).toMatchObject({ unverified: 1, imported: 0 });
  expect(await importWorldBossRanking(apply, lockFile)).toMatchObject({ imported: 1 });
  await writeFile(input.sourceFile, JSON.stringify({ ...legacy, [grant.uid]: [{ name: "急冻树", kill_num: 99 }] }));
  expect(await importWorldBossRanking(apply, lockFile)).toMatchObject({ conflict: 1, imported: 0 });
  await writeFile(input.authorizationFile, JSON.stringify({ version: 1, roles: [{ ...grant, qq: "800" }] }));
  expect(await importWorldBossRanking(apply, lockFile)).toMatchObject({ unverified: 1, imported: 0 });
  expect(await createGenshinWorldBossRanking(input.destinationDirectory, lockFile).rank())
    .toEqual([{ uid: grant.uid, name: "急冻树", killCount: 8 }]);
}));

test("重复 UID 授权、重复 JSON 键和符号链接不是可应用的输入", () => fixture(async (input) => {
  const apply = { ...input, apply: true };
  await writeFile(input.authorizationFile, JSON.stringify({ version: 1, roles: [grant, { ...grant, qq: "43" }] }));
  await expect(importWorldBossRanking(apply, lockFile)).rejects.toThrow("授权清单");
  await writeFile(input.authorizationFile, JSON.stringify({ version: 1, roles: [grant] }));
  await writeFile(input.sourceFile, `{"${grant.uid}":[],"${grant.uid}":[]}`);
  await expect(importWorldBossRanking(apply, lockFile)).rejects.toThrow("旧世界 BOSS 榜单");
  const link = input.sourceFile + ".link";
  await symlink(input.sourceFile, link);
  await expect(importWorldBossRanking({ ...apply, sourceFile: link }, lockFile)).rejects.toThrow("旧世界 BOSS 榜单");
  await expect(lstat(input.destinationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
}));
