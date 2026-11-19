import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZzzLegacyGacha } from "../plugins/zzz/gacha-legacy.ts";

const qq = "42";
const uid = "1300000002";
const wallTime = "2025-03-09 02:30:00";
const bands = [
  ["音擎频段", "GACHA_TYPE_WEAPON_UP", "3", "3001"],
  ["音擎回响", "GACHA_TYPE_WEAPON_RETURN", "103", "13001"],
  ["独家频段", "GACHA_TYPE_CHARACTER_UP", "2", "2001"],
  ["独家重映", "GACHA_TYPE_CHARACTER_RETURN", "102", "12001"],
  ["常驻频段", "GACHA_TYPE_PERMANENT", "1", "1001"],
  ["邦布频段", "GACHA_TYPE_BANGBOO", "5", "5001"],
] as const;

function draw(id: string, gachaType: string, fields: object = {}) {
  return { uid, id, gacha_id: "751403", gacha_type: gachaType, item_id: "14101", count: "1", time: wallTime,
    name: "新艾利都音擎", lang: "zh-cn", item_type: "音擎", rank_type: "4", ...fields };
}

async function fixture(run: (paths: { workspace: string; directory: string; user: string; file: string },
  write: (value: unknown) => Promise<void>) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-zzz-legacy-"));
  const directory = join(workspace, "zzzGachaJson");
  const user = join(directory, qq);
  const file = join(user, `${uid}.json`);
  try {
    await run({ workspace, directory, user, file }, async (value) => {
      await mkdir(user, { recursive: true });
      await writeFile(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("读取旧六频段的链接原始编号和 Cookie 序列，保留长 ID、精确排序和原区墙钟时间", () => fixture(async (paths, write) => {
  const [recent, earlier, cookie] = ["9223372036854775807", "9223372036854775806", "9223372036854775805"];
  const mixed = Object.fromEntries(bands.map(([name, , baseType, requestType], index) => {
    const once = `522337203685477580${index}`;
    const base = draw(once, baseType, { rank_type: 3, square_icon: "/home/remote/not-a-local-asset.png" });
    const formatted = draw(String(index + 2), requestType, { rank_type: "2" });
    const ck = draw(`322337203685477580${index}`, "2", { gacha_id: "0", item_type: name === "邦布频段" ? "邦布" : "音擎" });
    return [name, [formatted, ck, base]];
  }));
  const link = draw(recent!, "103", { name: "深海访客" });
  mixed["音擎回响"] = [draw(earlier!, "3", { real_gacha_type: "103" }),
    draw(recent!, "2", { gacha_id: "0", name: "深海访客" }), link,
    draw(cookie!, "2", { gacha_id: "0", rank_type: "2" })];
  await write(mixed);
  const previous = await readFile(paths.file);
  const stat = await lstat(paths.file);
  const archive = await readZzzLegacyGacha(paths.directory, qq, uid);
  expect(archive?.uid).toBe(uid);
  expect(archive?.pools.map(({ name, type, gachaType }) => [name, type, gachaType]))
    .toEqual(bands.map(([name, type, gachaType]) => [name, type, gachaType]));
  expect(archive?.pools.map(({ records }) => records.length)).toEqual([3, 3, 3, 3, 3, 3]);
  const weaponEncore = archive?.pools[1]?.records;
  expect(weaponEncore?.map(({ id, time, rank }) => [id, time, rank])).toEqual([
    [recent, wallTime, "4"], [earlier, wallTime, "4"], [cookie, wallTime, "2"],
  ]);
  expect(weaponEncore?.[0]).toEqual({ id: recent, itemId: "14101", gachaId: "751403", count: 1, time: wallTime,
    name: "深海访客", lang: "zh-cn", itemType: "音擎", rank: "4" });
  expect(archive?.pools.at(-1)?.records.map(({ itemType }) => itemType)).toEqual(["音擎", "邦布", "音擎"]);
  expect(archive).not.toHaveProperty("timezone");
  expect(await readFile(paths.file)).toEqual(previous);
  expect((await lstat(paths.file)).ino).toBe(stat.ino);
}));

test("缺档与合法空档可区分，只读取给定 QQ 的同 UID 文件", () => fixture(async (paths, write) => {
  expect(await readZzzLegacyGacha(paths.directory, qq, uid)).toBeUndefined();
  await write({});
  expect((await readZzzLegacyGacha(paths.directory, qq, uid))?.pools.every(({ records }) => !records.length)).toBe(true);
  await write({ "独家频段": [draw("5223372036854775801", "2001")] });
  expect((await readZzzLegacyGacha(paths.directory, qq, uid))?.pools[2]?.records).toHaveLength(1);
  expect(await readZzzLegacyGacha(paths.directory, "43", uid)).toBeUndefined();
  await expect(readZzzLegacyGacha(paths.directory, "../42", uid)).rejects.toMatchObject({ code: "corrupt" });
  await expect(readZzzLegacyGacha(paths.directory, qq, "1300000002.json")).rejects.toMatchObject({ code: "corrupt" });
}));

test("拒绝外国 UID、错频段、非真实重复及失真记录格式", () => fixture(async (paths, write) => {
  const id = "5223372036854775801";
  const valid = draw(id, "2001");
  const cases: [unknown, string][] = [
    [{ "未知频段": [valid] }, "频段结构"],
    [{ "独家频段": {} }, "频段记录"],
    [{ "独家频段": [draw(id, "2001", { uid: "1500000002" })] }, "记录 UID"],
    [{ "独家频段": [draw(id, "2001", { uid: undefined })] }, "记录 UID"],
    [{ "邦布频段": [valid] }, "记录频段"],
    [{ "独家重映": [draw(id, "2", { gacha_id: "1" })] }, "记录频段"],
    [{ "独家重映": [draw(id, "2", { gacha_id: "0", count: "2" })] }, "记录频段"],
    [{ "音擎回响": [draw(id, "13001", { real_gacha_type: "102" })] }, "真实频段"],
    [{ "独家频段": [valid], "邦布频段": [draw(id, "5")] }, "重复记录所属频段"],
    [{ "独家频段": [valid, draw(id, "2001", { rank_type: "2" })] }, "重复记录内容"],
    [{ "独家频段": [draw(id, "2001", { rank_type: "5" })] }, "物品稀有度"],
    [{ "独家频段": [draw(id, "2001", { id: Number(id) })] }, "记录编号"],
    [{ "独家频段": [draw(id, "2001", { time: "2025-02-29 12:00:00" })] }, "抽卡时间"],
  ];
  for (const [body, error] of cases) {
    await write(body);
    await expect(readZzzLegacyGacha(paths.directory, qq, uid)).rejects
      .toMatchObject({ code: "corrupt", message: expect.stringContaining(error) });
  }
}));

test("拒绝旧逐抽文件的非 UTF-8、超限大小和根、QQ、文件路径替代", () => fixture(async (paths, write) => {
  await write({});
  await writeFile(paths.file, new Uint8Array([0xff]));
  await expect(readZzzLegacyGacha(paths.directory, qq, uid)).rejects
    .toMatchObject({ code: "corrupt", message: expect.stringContaining("JSON") });
  await truncate(paths.file, 32 * 1024 * 1024 + 1);
  await expect(readZzzLegacyGacha(paths.directory, qq, uid)).rejects
    .toMatchObject({ code: "corrupt", message: expect.stringContaining("文件大小") });

  const outside = join(paths.workspace, "outside");
  await mkdir(outside);
  const outsideFile = join(outside, `${uid}.json`);
  await writeFile(outsideFile, "{}");
  await rm(paths.file);
  await symlink(outsideFile, paths.file);
  await expect(readZzzLegacyGacha(paths.directory, qq, uid)).rejects
    .toMatchObject({ code: "corrupt", message: expect.stringContaining("普通 JSON") });
  await rm(paths.user, { recursive: true });
  await symlink(outside, paths.user, "dir");
  await expect(readZzzLegacyGacha(paths.directory, qq, uid)).rejects
    .toMatchObject({ code: "corrupt", message: expect.stringContaining("QQ 目录") });
  await rm(paths.directory, { recursive: true });
  await symlink(outside, paths.directory, "dir");
  await expect(readZzzLegacyGacha(paths.directory, qq, uid)).rejects
    .toMatchObject({ code: "corrupt", message: expect.stringContaining("根目录") });
  await expect(readZzzLegacyGacha(`${paths.directory}/`, qq, uid)).rejects
    .toMatchObject({ code: "corrupt", message: expect.stringContaining("根目录") });
}));
