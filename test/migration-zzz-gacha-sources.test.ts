import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stageLegacyGameData } from "../lib/migration-game-data.ts";
import { readZzzFlatLegacyGacha } from "../plugins/zzz/gacha-legacy.ts";

const uid = "1300000002";
const legacy = `plugins/ZZZ-Plugin/data/gacha/${uid}.json`;
const active = `data/ZZZ-Plugin/gacha/${uid}.json`;
const draw = (id: string, fields = {}) => ({ uid, id, gacha_id: "751403", gacha_type: "2001", item_id: "14101", count: "1",
  time: "2025-03-09 02:30:00", name: "测试代理人", lang: "zh-cn", item_type: "代理人", rank_type: "4", ...fields });
async function fixture(run: (source: string, stage: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-gacha-migration-"));
  try { const source = join(root, "source"), stage = join(root, "stage");
    await mkdir(source); await mkdir(stage, { mode: 0o700 }); await run(source, stage);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function put(root: string, path: string, draws: unknown[]) {
  const file = join(root, path); await mkdir(dirname(file), { recursive: true });
  const bytes = JSON.stringify({ 独家频段: draws }, null, 2) + "\n";
  await writeFile(file, bytes); return bytes;
}

test("旧ZZZ插件是唯一抽卡来源时，迁移后实际读取器仍能读取全部长编号原档", () => fixture(async (source, stage) => {
  const bytes = await put(source, legacy, [draw("9223372036854775807", { unknown_field: { retained: true } })]);
  await stageLegacyGameData(source, stage);
  expect(await readFile(join(stage, active), "utf8")).toBe(bytes);
  expect((await readZzzFlatLegacyGacha([join(stage, "data/ZZZ-Plugin/gacha")], uid))?.pools.flatMap(pool => pool.records).map(row => row.id))
    .toEqual(["9223372036854775807"]);
  expect(await readFile(join(source, legacy), "utf8")).toBe(bytes);
}));

test("根目录与旧插件各有历史时保留双方缺档与原字段，同一抽不会变成重复统计", () => fixture(async (source, stage) => {
  const current = await put(source, active, [draw("9223372036854775807", { original: "root" })]);
  const old = await put(source, legacy, [draw("9223372036854775806", { original: "plugin" }), draw("9223372036854775807")]);
  await stageLegacyGameData(source, stage);
  const saved = JSON.parse(await readFile(join(stage, active), "utf8"));
  expect(saved.独家频段).toContainEqual(expect.objectContaining({ id: "9223372036854775806", original: "plugin" }));
  expect(saved.独家频段).toContainEqual(expect.objectContaining({ id: "9223372036854775807", original: "root" }));
  expect((await readZzzFlatLegacyGacha([join(stage, "data/ZZZ-Plugin/gacha")], uid))?.pools.flatMap(pool => pool.records).map(row => row.id))
    .toEqual(["9223372036854775807", "9223372036854775806"]);
  expect(await readFile(join(source, active), "utf8")).toBe(current);
  expect(await readFile(join(source, legacy), "utf8")).toBe(old);
}));

test("来源对同一抽的实际数值冲突时不得静默选择或当作迁移成功", () => fixture(async (source, stage) => {
  await put(source, active, [draw("9223372036854775807")]);
  await put(source, legacy, [draw("9223372036854775807", { item_id: "14102" })]);
  await expect(stageLegacyGameData(source, stage)).rejects.toThrow();
}));

test.skipIf(!Bun.which("git"))("完整迁移能识别改名的旧ZZZ插件，归档插件后历史仍在实际读档路径", () => fixture(async (source, stage) => {
  const { migrateInstallation } = await import("../scripts/migrate.ts");
  const target = join(stage, "candidate");
  await mkdir(target);
  const alias = "plugins/renamed-zzz";
  await put(source, `${alias}/data/gacha/${uid}.json`, [draw("9223372036854775807")]);
  await writeFile(join(source, alias, "package.json"), JSON.stringify({ name: "zzz-plugin" }));
  await writeFile(join(target, "package.json"), JSON.stringify({ name: "lotus-yunzai" }));
  await mkdir(join(target, "plugins"));
  await writeFile(join(target, "plugins/.fixture"), "fixture");
  for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: target });
    if (git.exitCode) throw new Error(git.stderr.toString());
  }
  expect(await migrateInstallation(source, target)).toMatchObject({ status: "published", archiveCount: 1 });
  expect(await Bun.file(join(target, alias, "package.json")).exists()).toBe(false);
  expect(await readFile(join(target, `backup/${alias}/data/gacha/${uid}.json`), "utf8"))
    .toBe(await readFile(join(source, `${alias}/data/gacha/${uid}.json`), "utf8"));
  expect((await readZzzFlatLegacyGacha([join(target, "data/ZZZ-Plugin/gacha")], uid))?.pools.flatMap(pool => pool.records).map(row => row.id))
    .toEqual(["9223372036854775807"]);
}));
