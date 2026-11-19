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
  await expect(reader({ ...avatar, id: 1341 }, "/not/loaded")).rejects.toThrow(/只有安比/u);
  await expect(reader(avatar, undefined)).rejects.toThrow(/未配置/u);
  await expect(reader(avatar, "/not/loaded")).rejects.toThrow(/版本一致/u);
  const unverified = { ...avatar, weapon: { id: 14177, name: "合成未确认音擎", rarity: "S", star: 1, level: 30 } };
  expect(() => calculatePanelDamage(unverified, numericFixture, noGear)).toThrow(/音擎/u);
  expect(() => calculatePanelDamage({ ...avatar, properties: [] }, numericFixture, noGear)).toThrow(ZzzDamageUnavailable);
  expect(() => calculatePanelDamage({ ...avatar, skills: [] }, numericFixture, noGear)).toThrow(/技能等级/u);
});
