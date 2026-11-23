import { expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { stageLegacyGameData } from "../lib/migration-game-data.ts";
import { createZzzMonthlyArchive } from "../plugins/zzz/monthly-archive.ts";
import { createZzzPanelStorage, decodeZzzPanelRows } from "../plugins/zzz/panel-storage.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

const uid = "123456789";
const otherUid = "1300000002";
const identity = { qq: "42", uid, region: "prod_gf_cn" };
const monthPath = `data/ZZZ-Plugin/monthly/${uid}.json`;
const panelPath = `data/ZZZ-Plugin/panel/${uid}.json`;
const plugin = "plugins/ZZZ-Plugin";
const mirror = `${plugin}/data`;
const monthMirror = `${mirror}/monthly/${uid}.json`;
const panelMirror = `${mirror}/panel/${uid}.json`;
const actor = { id: 1151, name_mi18n: "测试代理人", rarity: "S", level: 50, rank: 0 };
const alternate = { ...actor, id: 1141, name_mi18n: "另一个代理人" };
const verify = async () => {};

function monthly(data_month: string, count: number, role = identity, type = "PolychromesData") {
  return { uid: role.uid, region: role.region, data_month, month_data: {
    list: [{ data_type: type, count }], income_components: [{ action: "Daily", num: count }],
  } };
}

async function put(root: string, path: string, value: unknown) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  await writeFile(file, text);
  return text;
}

async function fixture(run: (source: string, stage: string, target: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-migration-zzz-archives-"));
  const source = join(directory, "old"), stage = join(directory, "stage"), target = join(directory, "candidate");
  try {
    await Promise.all([mkdir(source), mkdir(stage, { mode: 0o700 }), mkdir(target)]);
    await run(source, stage, target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function candidate(target: string) {
  await put(target, "package.json", { name: "lotus-yunzai" });
  await put(target, "plugins/.fixture", {});
  for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: target });
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
}

function readers(root: string) {
  return {
    months: createZzzMonthlyArchive(join(root, "data/zzzMonthly"), [join(root, "data/ZZZ-Plugin/monthly")], lockFile),
    panels: createZzzPanelStorage(lockFile, { legacy: join(root, "data/ZZZ-Plugin"), managed: join(root, "data/zzzPanels") }),
  };
}

test.skipIf(!Bun.which("git"))("初次迁移归档拒载插件后，月报历史与旧面板仍可用，重跑保留新档", () =>
  fixture(async (source, _stage, target) => {
    await put(source, `${plugin}/package.json`, { name: "zzz-plugin" });
    await put(source, "plugins/old-zzz/package.json", { name: "zzz-plugin" });
    await put(source, `data/old-zzz/monthly/${uid}.json`, [monthly("202604", 5)]);
    const newestLegacy = await put(source, monthPath, [monthly("202606", 20), monthly("202607", 35)]);
    const oldReport = await put(source, monthMirror, [
      monthly("202605", 10), monthly("202606", 15), monthly("202607", 2, identity, "BooponsData"),
    ]);
    const oldPanel = await put(source, panelMirror, [actor]);
    await candidate(target);

    const result = await migrateInstallation(source, target);
    expect(result).toMatchObject({ status: "published", archiveCount: 2,
      gameData: { active: [{ path: "data/ZZZ-Plugin/monthly", files: 1 }, { path: "data/ZZZ-Plugin/panel", files: 1 }] } });
    await expect(lstat(join(target, plugin))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(target, "backup", monthMirror), "utf8")).toBe(oldReport);
    expect(await readFile(join(target, "backup", panelMirror), "utf8")).toBe(oldPanel);
    expect(await readFile(join(target, panelPath), "utf8")).toBe(oldPanel);
    expect((await lstat(join(target, monthPath))).mode & 0o777).toBe(0o600);

    const { months, panels } = readers(target);
    const before = await months.read(identity);
    expect(before.map(row => row.data_month)).toEqual(["202607", "202606", "202605", "202604"]);
    expect(before[1]?.month_data.list).toEqual([{ data_type: "PolychromesData", count: 20 }]);
    expect(before[0]?.month_data.list).toContainEqual({ data_type: "BooponsData", count: 2 });
    expect((await panels.read(identity)).map(row => row.id)).toEqual([actor.id]);
    expect(await panels.read({ ...identity, uid: "123456788" })).toEqual([]);
    expect(await panels.read({ ...identity, region: "prod_qd_cn" })).toEqual([]);
    await expect(months.read({ ...identity, region: "prod_qd_cn" })).rejects.toThrow();

    const current = await months.update(identity, [monthly("202607", 40), monthly("202608", 80)], 200, verify);
    await months.update(identity, [monthly("202607", 1)], 100, verify);
    const monthArchive = join(target, "data/zzzMonthly", identity.qq, `${uid}.json`);
    const afterMonth = await readFile(monthArchive);
    const updatedPanel = await panels.merge(identity, decodeZzzPanelRows([{ ...actor, rank: 3 }, alternate]), verify);
    const panelArchive = join(target, "data/zzzPanels", identity.region, identity.qq, `${uid}.json`);
    const afterPanel = await readFile(panelArchive);
    expect(current.find(row => row.data_month === "202607")?.month_data.list)
      .toContainEqual({ data_type: "PolychromesData", count: 40 });
    expect(await months.read(identity)).toEqual(current);
    expect(updatedPanel.map(row => [row.id, row.rank])).toEqual([[actor.id, 3], [alternate.id, 0]]);

    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published", gameData: result.gameData });
    expect(await readFile(monthArchive)).toEqual(afterMonth);
    expect(await readFile(panelArchive)).toEqual(afterPanel);
    expect(await readFile(join(source, monthPath), "utf8")).toBe(newestLegacy);
    expect(await readFile(join(source, monthMirror), "utf8")).toBe(oldReport);
    expect(await readFile(join(source, panelMirror), "utf8")).toBe(oldPanel);
  }));

test.skipIf(!Bun.which("git"))("首次迁移拒绝覆盖已有现代数据目录", () =>
  fixture(async (source, _stage, target) => {
    await put(source, `${plugin}/package.json`, { name: "zzz-plugin" });
    await put(source, monthPath, [monthly("202607", 35)]);
    await put(source, panelPath, [actor]);
    await candidate(target);
    const { months, panels } = readers(target);
    const before = await months.update(identity, [monthly("202608", 80)], 200, verify);
    const beforePanel = await panels.merge(identity, decodeZzzPanelRows([alternate]), verify);
    await expect(migrateInstallation(source, target)).rejects.toThrow("已有 data");
    await expect(lstat(join(target, panelPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await months.read(identity)).toEqual(before);
    expect(await panels.read(identity)).toEqual(beforePanel);
  }));

test("主目录面板整档优先，已归档的插件可补不同 UID 的旧月报和面板", () =>
  fixture(async (source, stage) => {
    const rootPanel = await put(source, panelPath, [actor]);
    await put(source, panelMirror, [alternate]);
    const archivedRole = { qq: "43", uid: otherUid, region: "prod_gf_jp" };
    const archivedMonth = [monthly("202606", 35, archivedRole)];
    const oldPanel = await put(source, panelMirror.replace(uid, otherUid).replace(plugin, `backup/${plugin}`), [alternate]);
    await put(source, monthMirror.replace(uid, otherUid).replace(plugin, `backup/${plugin}`), archivedMonth);
    await stageLegacyGameData(source, stage);
    expect(await readFile(join(stage, panelPath), "utf8")).toBe(rootPanel);
    expect(await readFile(join(stage, panelPath.replace(uid, otherUid)), "utf8")).toBe(oldPanel);
    const { months, panels } = readers(stage);
    expect((await months.read(archivedRole)).map(row => row.data_month)).toEqual(["202606"]);
    expect((await panels.read(archivedRole)).map(row => row.id)).toEqual([alternate.id]);
    await expect(panels.read({ ...archivedRole, region: "prod_gf_eu" })).rejects.toThrow("归属不明");
  }));

test("不接纳月报 UID、区服、游戏归属错误或不合法面板", async () => {
  const cases = [
    [monthPath, [monthly("202606", 20, { ...identity, uid: "123456788" })]],
    [monthPath.replace(uid, otherUid), [monthly("202606", 20, { ...identity, uid: otherUid, region: "prod_gf_eu" })]],
    [monthPath, [{ ...monthly("202606", 20), game_biz: "nap_global" }]],
    [panelPath, [actor, actor]],
    [panelPath.replace(uid, "9900000001"), [actor]],
  ] as const;
  for (const [path, data] of cases) {
    await fixture(async (source, stage) => {
      await put(source, path, data);
      await expect(stageLegacyGameData(source, stage)).rejects.toThrow("读取或归属不符");
      await expect(lstat(join(stage, path))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
  await fixture(async (source, stage) => {
    await put(source, monthPath, [monthly("202606", 20)]);
    await put(source, monthMirror, [monthly("202606", 25, { ...identity, region: "prod_qd_cn" })]);
    await expect(stageLegacyGameData(source, stage)).rejects.toThrow("读取或归属不符");
    await expect(lstat(join(stage, monthPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("迁移不跟随月报文件和旧面板目录链接，也不读硬链接或超大档", async () => {
  for (const kind of ["file-link", "hard-link", "directory-link", "oversize"] as const) {
    await fixture(async (source, stage) => {
      const outside = join(dirname(source), "outside");
      await put(outside, `${uid}.json`, [monthly("202606", 20)]);
      const file = join(source, monthPath);
      await mkdir(dirname(file), { recursive: true });
      if (kind === "file-link") await symlink(join(outside, `${uid}.json`), file);
      if (kind === "hard-link") await link(join(outside, `${uid}.json`), file);
      if (kind === "oversize") await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
      if (kind === "directory-link") await symlink(outside, join(source, "data/ZZZ-Plugin/panel"));
      await expect(stageLegacyGameData(source, stage)).rejects.toThrow(/实体目录|无硬链接/);
      await expect(lstat(join(stage, monthPath))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
});
