import { expect, test } from "bun:test";
import type { ZzzPanelAvatar } from "../packages/hoyo-client/zzz-panel.ts";
import type { DamageData } from "../plugins/zzz/damage-engine/types.ts";
import { zzzPanelCommand } from "../plugins/zzz/panel-command.ts";
import { calculatePanelDamage, createPanelDamageReader, ZzzDamageUnavailable } from "../plugins/zzz/panel-damage.ts";

const numericFixture: DamageData = {
  character: { skill: Object.fromEntries(["AX", "CF", "EQ", "RL", "RZ"].map((name, index) => [name, [index + 1]])) },
  anomaly: [{ name: "感电", duration: 1, interval: 1, multiplier: 0.5, element_type: 203, sub_element_type: 0 }],
  property: { idToName: () => null, nameToShortName3: name => name, nameZHToNameEN: () => "" },
};
const avatar: ZzzPanelAvatar = {
  id: 1011, name_mi18n: "安比", level: 30, rank: 0, rarity: "A", avatar_profession: 2, element_type: 203,
  skills: [0, 1, 2, 3, 5, 6].map(skill_type => ({ skill_type, level: 1 })),
  properties: [
    ["生命值", "1000"], ["攻击力", "100"], ["防御力", "100"], ["冲击力", "100"], ["暴击率", "0%"],
    ["暴击伤害", "10%"], ["异常掌控", "100"], ["异常精通", "100"], ["能量自动回复", "1.20"], ["穿透率", "0%"],
  ].map(([property_name, final]) => ({ property_name, base: "", final })),
};
const noGear = { suits: {}, weapons: {} };

test("伤害入口保留技能编号，可明确选择同 QQ 的档案", () => {
  expect(zzzPanelCommand("%安比伤害")).toEqual({ kind: "damage", profileId: 1, name: "安比", skill: undefined });
  expect(zzzPanelCommand("#zzz安东伤害3 档案2")).toEqual({ kind: "damage", profileId: 2, name: "安东", skill: 3 });
  expect(zzzPanelCommand("%安比伤害0")).toEqual({ kind: "damage", profileId: 1, name: "安比", skill: 0 });
  for (const invalid of ["安比伤害3", "%伤害3", "%安比伤害1 档案0", "%安比伤害3 2", "%安比伤害1 档案256"]) {
    expect(zzzPanelCommand(invalid)).toBeUndefined();
  }
});

test("合成数据通过原计算器选择技能，保留零暴击及默认最大期望伤害", () => {
  const picked = calculatePanelDamage(avatar, numericFixture, noGear, 0);
  expect(picked.skills).toHaveLength(6);
  expect(picked.skillIndex).toBe(0);
  expect(picked.selected.skill.name).toBe("感电每段");
  expect(picked.selected.result.critDMG).toBe(0);
  expect(calculatePanelDamage(avatar, numericFixture, noGear).selected.skill.type).toBe("RZ");
  expect(calculatePanelDamage(avatar, numericFixture, noGear, 999).skillIndex).toBe(5);
});

test("缺乏角色、配装、原始资料或属性证据时不给出伤害数值", async () => {
  const reader = createPanelDamageReader();
  await expect(reader({ ...avatar, id: 1341 }, "/not/loaded")).rejects.toThrow(/尚未核验/u);
  await expect(reader(avatar, undefined)).rejects.toThrow(/未配置/u);
  await expect(reader(avatar, "/not/loaded")).rejects.toThrow(/版本一致/u);
  const unverified = { ...avatar, weapon: { id: 14177, name: "合成未确认音擎", rarity: "S", star: 1, level: 30 } };
  expect(() => calculatePanelDamage(unverified, numericFixture, noGear)).toThrow(/音擎/u);
  expect(() => calculatePanelDamage({ ...avatar, properties: [] }, numericFixture, noGear)).toThrow(ZzzDamageUnavailable);
  expect(() => calculatePanelDamage({ ...avatar, skills: [] }, numericFixture, noGear)).toThrow(/技能等级/u);
});

test("冰、以太与物理使用角色自身属性，按旧规则保留可见技能顺序", () => {
  const cases = [
    [1191, "艾莲", 202, "碎冰", ["AQ3", "CF", "CCP", "CCX0", "CCXP", "CCXX", "EQ1", "EQ2", "RL", "RZ"]],
    [1241, "朱鸢", 205, "侵蚀", ["AQY3", "CCQ", "EQ", "RL", "RZ"]],
    [1061, "可琳", 200, "强击", ["AP5", "CF", "EQ0", "EQ", "RL", "RZ"]],
  ] as const;
  for (const [id, name_mi18n, element_type, anomaly, multipliers] of cases) {
    const original = { ...avatar, id, name_mi18n, element_type, avatar_profession: 1 };
    const data: DamageData = {
      ...numericFixture,
      character: { skill: Object.fromEntries(multipliers.map(name => [name, [1]])) },
      anomaly: [{ ...numericFixture.anomaly[0]!, name: anomaly, element_type }],
    };
    const current = calculatePanelDamage(original, data, noGear, 1);
    expect(current.selected.skill.type).toBe(anomaly);
    expect(current.skills.map(row => row.skill.type)).toEqual(
      [anomaly, ...multipliers.filter(type => type !== "CCX0" && type !== "EQ0")],
    );
    expect(() => calculatePanelDamage({ ...original, element_type: 203 }, data, noGear)).toThrow(/规则/u);
    if (id === 1241) {
      const mindscape = calculatePanelDamage({ ...original, rank: 6 }, data, noGear, 4);
      expect(mindscape.selected.skill.type).toBe("EQ");
      expect(mindscape.selected.result.expectDMG).toBeGreaterThan(current.skills[3]!.result.expectDMG);
      expect(mindscape.skills.map(row => row.skill.type)).toEqual(current.skills.map(row => row.skill.type));
    }
  }
});

test("露西的六影召唤物按旧序号显示，各档案独立计算攻击力", () => {
  const lucy = { ...avatar, id: 1151, name_mi18n: "露西", element_type: 201, avatar_profession: 4 };
  const data: DamageData = {
    ...numericFixture,
    character: {
      skill: Object.fromEntries(["AP4", "AZCD", "AZH", "CF", "EQP", "EQX", "RL", "RZ"].map(name => [name, [1]])),
      buff: { E1: [0.1], E2: [1], T: [1] },
    },
    anomaly: [{ ...numericFixture.anomaly[0]!, name: "灼烧", element_type: 201 }],
  };
  const low = calculatePanelDamage(lucy, data, noGear, 3);
  expect(low.selected.skill.type).toBe("AZCD");
  expect(low.skills.some(row => row.skill.type === "Y6")).toBe(false);
  const stronger = calculatePanelDamage({
    ...lucy, rank: 6,
    properties: (avatar.properties as { property_name: string; base: string; final: string }[]).map(row =>
      row.property_name === "攻击力" ? { ...row, final: "200" } : row),
  }, data, noGear, 5);
  expect(stronger.selected.skill.type).toBe("Y6");
  expect(stronger.skills[2]!.result.expectDMG).toBeGreaterThan(low.selected.result.expectDMG);
  expect(calculatePanelDamage(lucy, data, noGear, 3).selected.result).toEqual(low.selected.result);
});

test("命破用旧贯穿乘区，允许面板省去普通能量和穿透率", () => {
  const properties = (avatar.properties as { property_name: string }[]).filter(row =>
    row.property_name !== "能量自动回复" && row.property_name !== "穿透率");
  const data: DamageData = {
    ...numericFixture,
    character: { skill: Object.fromEntries(["AQ4", "CF", "EP", "EQ", "LTT", "LTL", "RL", "RQ"].map(name => [name, [1]])) },
  };
  const haru = { ...avatar, id: 1441, name_mi18n: "真斗", element_type: 201, avatar_profession: 6, properties };
  const actual = calculatePanelDamage(haru, data, noGear, 5);
  expect(actual.skills).toHaveLength(7);
  expect(actual.selected.skill.type).toBe("LTT");
  expect(actual.selected.skill.isSheerDMG).toBe(true);
  expect(actual.selected.areas.DefenceArea).toBe(1);
  expect(actual.selected.result.expectDMG).toBeGreaterThan(actual.skills[0]!.result.expectDMG);
});

test("星见雅的碎冰和紊乱选择原特殊属性，拒绝混入普通冰数据", () => {
  const miyabi = {
    ...avatar, id: 1091, name_mi18n: "雅", element_type: 202, sub_element_type: 1, avatar_profession: 3,
  };
  const multiplier = { ...numericFixture.anomaly[0]!, name: "碎冰" as const, element_type: 202 };
  const data: DamageData = {
    ...numericFixture,
    character: {
      skill: Object.fromEntries(["AP5", "CF", "TP", "AX1", "AX2", "AX3", "EQ1", "EQ2", "RL", "RZ"].map(name => [name, [1]])),
    },
    anomaly: [
      { ...multiplier, discover: { multiplier: 0.2, fixed_multiplier: 0.2 } },
      { ...multiplier, sub_element_type: 1, multiplier: 3, discover: { multiplier: 0.5, fixed_multiplier: 1 } },
    ],
  };
  const actual = calculatePanelDamage(miyabi, data, noGear, 2);
  expect(actual.selected.skill.type).toBe("紊乱");
  expect(actual.skills[0]!.props?.倍率).toBe(3);
  expect(actual.selected.props?.倍率).toBe(1.5);
  expect(() => calculatePanelDamage({ ...miyabi, sub_element_type: 0 }, data, noGear)).toThrow(/规则/u);
});
