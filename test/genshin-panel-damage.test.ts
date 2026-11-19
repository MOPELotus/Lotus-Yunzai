import { expect, test } from "bun:test";
import { estimatePanelDamage } from "../plugins/genshin/panel/damage.ts";
import { matchGenshinPanel, type Json, type PanelAvatar } from "../plugins/genshin/panel/model.ts";
import type { PanelTheme } from "../plugins/genshin/panel/theme.ts";

const avatar: PanelAvatar = {
  id: 10000046, name: "胡桃", elem: "pyro", level: 90, promote: 6, cons: 0, _source: "enka",
  talent: { a: 1, e: 1, q: 1 },
  weapon: { name: "新手长枪", level: 90, promote: 6, affix: 1 },
  artis: { 1: { name: "冒险家之花", set: "冒险家", level: 20, star: 5, mainId: 14001, attrIds: [] } },
};
const actor = ({ attack = 270, hpToAttack = 5, q = true } = {}): Json => ({
  name: "胡桃", weapon: "polearm",
  attr: { keys: ["hp", "atk", "def", "cdmg"], details: { "80+": [9000, 190, 500, 10], "90": [10000, 200, 550, 20] } },
  talentData: {
    a: { 重击伤害: [attack] },
    e: { 攻击力提高: [hpToAttack] },
    q: q ? { 低血量时技能伤害: [350] } : { unrelated: [123] },
  },
});
const weapon = { name: "新手长枪", attr: { atk: { "80+": 230, "90": 250 } } };

function theme(data = actor(), asset: Json = weapon): PanelTheme {
  return { characters: {}, artifacts: new Map(), artifactSets: new Map(),
    async metadata(_game, kind) { return kind === "character" ? data : asset; },
    async picture() { return undefined; },
  };
}

test("旧伤害序号和绑定档案号相互独立，并保留显式 UID 校验入口", () => {
  expect(matchGenshinPanel("#胡桃伤害2")).toMatchObject({ mode: "damage", damageRow: 2, profileId: 1 });
  expect(matchGenshinPanel("#原神胡桃伤害2 档案3")).toMatchObject({ mode: "damage", damageRow: 2, profileId: 3 });
  expect(matchGenshinPanel("#胡桃伤害2 100123456")).toMatchObject({ mode: "damage", damageRow: 2, uid: "100123456" });
  expect(matchGenshinPanel("#胡桃伤害100123456")).toMatchObject({ mode: "damage", uid: "100123456" });
  expect(matchGenshinPanel("#星铁卡芙卡伤害2")).toBeUndefined();
});

test("原版胡桃旧公式保留低血量、E 攻击力增益、蒸发及词条对照", async () => {
  const result = await estimatePanelDamage(avatar, theme());
  if (!("rows" in result)) throw new Error(result.message);
  const hp = 10_000 + 3.885 * (1.875 * 41) * (1.2 + 0.34 * 20) * 2;
  const defense = 190 / 393;
  const base = (450 + hp * 0.05) * 2.7 * 1.33 * defense * 0.9;
  expect(result.enemyLevel).toBe(103);
  expect(result.selected).toBe(1);
  expect(result.rows[0]?.average).toBeCloseTo(base * (1 + 0.05 * 0.7), 8);
  expect(result.rows[0]?.crit).toBeCloseTo(base * 1.7, 8);
  expect(result.rows[1]?.average).toBeCloseTo(base * (1 + 0.05 * 0.7) * 1.5, 8);
  expect(result.rows[1]?.buffs).toContain("胡桃被动：半血获得33%火伤加成");
  expect(result.comparison?.axes).toEqual(["生命值", "攻击力", "暴击率", "暴击伤害", "元素精通"]);
  expect(result.comparison?.cells[0]?.[0]).toEqual({});
  expect(result.comparison?.cells[0]?.[1]?.average).not.toBe(result.rows[1]?.average);
  expect(await estimatePanelDamage(avatar, theme(), 4)).toMatchObject({ message: expect.stringContaining("3种") });
});

test("缺失倍率不会作为零伤害，已知零数值及其他完整情景仍可查询", async () => {
  const partial = await estimatePanelDamage(avatar, theme(actor({ q: false })), 3);
  if (!("rows" in partial)) throw new Error(partial.message);
  expect(partial.selected).toBe(2);
  expect(partial.rows[2]).toEqual({ title: "半血开E后Q", unavailable: true, buffs: [] });
  expect(partial.rows[0]?.average).toBeGreaterThan(0);
  expect(partial.comparison).toBeUndefined();

  const zero = await estimatePanelDamage(avatar, theme(actor({ attack: 0 })), 1);
  if (!("rows" in zero)) throw new Error(zero.message);
  expect(zero.rows[0]).toMatchObject({ average: 0, crit: 0 });
  expect(await estimatePanelDamage({ ...avatar, talent: { ...avatar.talent, e: undefined } }, theme()))
    .toEqual({ message: "天赋等级或旧版倍率表不完整，请先更新面板。" });
  expect(await estimatePanelDamage(avatar, theme(actor(), {}))).toEqual({ message: "旧主题缺少当前武器的属性表。" });
});
