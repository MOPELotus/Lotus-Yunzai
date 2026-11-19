import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGenshinPublicPoolSources } from "../plugins/genshin/gacha-detail-source.ts";
import { buildGenshinPublicPool, matchGenshinPublicPool, pageGenshinPublicPools,
  type GenshinPoolQuery, type PublicPoolSources } from "../plugins/genshin/gacha-pool.ts";

const first = { version: "4.5", half: "上半", from: "2024-03-13 06:00:00", to: "2024-04-02 17:59:59",
  char5: ["优菈"], char4: ["砂糖"], weapon5: ["松籁响起之时"], weapon4: ["西风剑"] };
const second = { ...first, half: "下半", from: "2024-04-02 18:00:00", to: "2024-04-23 14:59:59" };
const mix = { ...first, char5: ["优菈", "可莉", "七七"], char4: ["砂糖", "米卡", "罗莎莉亚", "迪奥娜", "诺艾尔",
  "班尼特", "菲谢尔", "安柏", "雷泽", "凯亚", "芭芭拉", "丽莎"], weapon5: ["松籁响起之时", "旧池有名但图包缺失"] };
const sources: PublicPoolSources = {
  regular: [first, second], mixed: [mix],
  characters: new Map([["优菈", { name: "优菈", img: "/meta-gs/character/优菈/imgs/face.webp" }]]),
  weapons: new Map([["松籁响起之时", { name: "松籁响起之时", abbr: "松籁之时", img: "meta-gs/weapon/claymore/松籁响起之时/icon.webp" }]]),
  weaponAliases: { 松籁响起之时: "松籁" },
};

function query(input: string): Exclude<GenshinPoolQuery, { type: "help" }> {
  const result = matchGenshinPublicPool(input);
  if (!result || result.type === "help") throw new Error(`测试命令未解析：${input}`);
  return result;
}

test("旧原神版本、上下半与集录匹配精确，保留同半录入顺序和每行八件", () => {
  expect(matchGenshinPublicPool("#卡池帮助")).toEqual({ type: "help" });
  for (const message of ["#星铁4.5卡池", "*4.5卡池", "#绝区零4.5卡池", "#武器抽卡记录", "#模拟祈愿", "#4..5卡池"]) {
    expect(matchGenshinPublicPool(message)).toBeUndefined();
  }
  const model = buildGenshinPublicPool(query("#4.5卡池"), sources, 0);
  if (!model || !("pools" in model)) throw new Error("缺失版本卡池");
  expect(model.pools.map(pool => [pool.half, pool.isMix])).toEqual([["下半", false], ["上半", false], ["上半", true]]);
  expect(model.pools[2]?.groups.map(group => [group.title, group.rows.map(row => row.length)]))
    .toEqual([["五星角色", [3]], ["四星角色", [8, 4]], ["五星武器", [2]], ["四星武器", [1]]]);
  expect(model.pools[2]?.groups[2]?.rows[0]?.[1]).toMatchObject({ name: "旧池有名但图包缺失", img: undefined, star: 5 });
  expect(buildGenshinPublicPool(query("#4.5下半卡池"), sources, 0)).toMatchObject({ pools: [{ half: "下半", isMix: false }] });
  expect(buildGenshinPublicPool(query("#4.50上半卡池"), sources, 0)).toEqual({ message: "未找到 原神4.50上半 的卡池信息" });
  const threePhases = buildGenshinPublicPool(query("#4.5卡池"), { ...sources, regular: [first, { ...first, half: "中场" }, second] }, 0);
  if (!threePhases || !("pools" in threePhases)) throw new Error("旧档中场缺失");
  expect(threePhases.pools.map(pool => pool.half)).toEqual(["下半", "上半", "中场", "上半"]);
});

test("别名只取准确项目，默认保留命中星级组的完整多行，详情保留其他组", () => {
  const simple = buildGenshinPublicPool(query("#砂糖卡池"), sources, 0);
  if (!simple || !("pools" in simple)) throw new Error("缺失简版卡池");
  expect(simple.pools.every(pool => pool.groups.length === 1 && pool.groups[0]?.title === "四星角色")).toBe(true);
  expect(simple.pools[2]?.groups[0]?.rows.map(row => row.length)).toEqual([8, 4]);
  const full = buildGenshinPublicPool(query("#松籁卡池详细"), sources, 0);
  if (!full || !("pools" in full)) throw new Error("缺失完整版卡池");
  expect(full.pools[0]?.groups).toHaveLength(4);
  expect(buildGenshinPublicPool(query("#77卡池"), sources, 0)).toMatchObject({ pools: [{ isMix: true }] });
  expect(buildGenshinPublicPool(query("#白厄卡池"), sources, 0)).toBeUndefined();
  expect(buildGenshinPublicPool(query("#原神白厄卡池"), sources, 0)).toEqual({ message: "未找到 白厄 的卡池信息" });
  const collision = { ...sources, characterAliases: { 优菈: "双义" }, weaponAliases: { 松籁响起之时: "双义" } };
  expect(buildGenshinPublicPool(query("#双义卡池"), collision, 0)).toEqual({ message: "有多个原神角色或武器匹配，请使用完整名称查询卡池。" });
  expect(pageGenshinPublicPools([...full.pools, ...full.pools, ...full.pools]).flat()).toHaveLength(full.pools.length * 3);
});

test("CN 时区边界和未来期次保留真实复刻状态，错误结束时间使状态待定", () => {
  const at = (time: string) => Date.parse(time);
  const name = query("#优菈卡池");
  expect(buildGenshinPublicPool(name, sources, at("2024-03-13T06:00:00+08:00"))).toMatchObject({ reprint: { up: true, days: 0 } });
  expect(buildGenshinPublicPool(name, sources, at("2024-04-23T14:59:59+08:00"))).toMatchObject({ reprint: { up: true, days: 0 } });
  const upcoming = { ...first, version: "4.6", from: "2024/05/12 18:00", to: "2024/05/31 17:59" };
  const now = at("2024-04-27T15:00:00+08:00");
  expect(buildGenshinPublicPool(name, { ...sources, regular: [...sources.regular, upcoming] }, now))
    .toMatchObject({ reprint: { up: false, days: 4 }, pools: [{ version: "4.6" }, expect.anything(), expect.anything(), expect.anything()] });
  const broken = { ...first, version: "4.7", from: "2024-04-26 06:00:00", to: "22024-05-16 17:59:59" };
  const model = buildGenshinPublicPool(name, { ...sources, regular: [...sources.regular, broken] }, now);
  expect(model).toMatchObject({ reprint: undefined });
  if (!model || !("pools" in model)) throw new Error("格式错误仍应保留池内容");
  expect(model.pools[0]).toMatchObject({ version: "4.7", from: broken.from, to: "未知" });
});

test("现有目录原样读取角色、武器、别名和两个原神池导出", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-public-pool-"));
  const root = join(directory, "meta-gs");
  try {
    await Promise.all(["character", "weapon/claymore/松籁响起之时", "info"].map(path => mkdir(join(root, path), { recursive: true })));
    await Promise.all([
      writeFile(join(root, "character", "data.json"), JSON.stringify({ 10000051: { name: "优菈", star: 5 } })),
      writeFile(join(root, "character", "alias.js"), "export const alias = {\n  // 别名\n  优菈: '旧档专名'\n}\n"),
      writeFile(join(root, "weapon", "claymore", "松籁响起之时", "data.json"), JSON.stringify({ id: "12503", name: "旧详情别名", star: 5 })),
      writeFile(join(root, "weapon", "claymore", "data.json"), JSON.stringify({ 12503: { id: "12503", name: "松籁响起之时", star: 5 } })),
      writeFile(join(root, "weapon", "alias.js"), "export const abbr = { 松籁响起之时: '松籁之时' }\nexport const alias = { 松籁响起之时: '松籁' }\n"),
      writeFile(join(root, "info", "pool.js"), `export const poolDetail = ${JSON.stringify([{ ...first, weapon5: ["松籁之时"] }])}\nexport const mixPoolDetail = ${JSON.stringify([mix])}`),
    ]);
    const actual = await readGenshinPublicPoolSources(directory);
    expect(actual.regular).toHaveLength(1);
    expect(actual.mixed).toHaveLength(1);
    expect(actual.weapons.get("松籁响起之时")?.abbr).toBe("松籁之时");
    expect(actual.weapons.get("松籁响起之时")?.img).toContain("claymore/松籁响起之时/");
    expect(buildGenshinPublicPool(query("#旧档专名卡池"), actual, 0)).toMatchObject({ game: "gs" });
    const weapon = buildGenshinPublicPool(query("#松籁卡池"), actual, 0);
    if (!weapon || !("pools" in weapon)) throw new Error("缺失武器卡池");
    expect(weapon.pools).toHaveLength(2);
    expect(weapon.pools[0]?.groups[0]?.rows[0]?.[0]).toMatchObject({ name: "松籁响起之时" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
