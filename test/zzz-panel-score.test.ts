import { expect, test } from "bun:test";
import type { ZzzPanelAvatar } from "../packages/hoyo-client/zzz-panel.ts";
import { buildZzzPanelScore, zzzDiscScoreComment, zzzPanelScoreComment } from "../plugins/zzz/panel-score.ts";

const avatar: ZzzPanelAvatar = {
  id: 1011, name_mi18n: "安比", rank: 0, rarity: "A", level: 60, avatar_profession: 2, element_type: 203,
  properties: [
    { property_name: "攻击力", base: "1000", final: "1770" },
    { property_name: "暴击率", base: "5%", final: "25%" },
    { property_name: "暴击伤害", base: "50%", final: "80%" },
  ],
};

function disc(slot = 1, rarity = "S", level = 15, main = 11103, crit = "7.2%") {
  return {
    id: 31040 + slot, name: `啄木鸟电音[${slot}]`, level, rarity, equipment_type: slot,
    main_properties: [{ property_id: main, property_name: "生命值", base: "2200" }],
    properties: [{ property_id: 20103, property_name: "暴击率", base: crit }],
  };
}

test("评分保留旧四项副词条理论上限、首三槽保底、后槽主词条权重及等级和稀有度惩罚", () => {
  const score = buildZzzPanelScore({ ...avatar, equip: [
    disc(), disc(2, "B", 0, 12103, "0%"), disc(4, "A", 15, 20103), disc(6, "S", 15, 11102, "0%"),
  ] })!;
  expect(score.rule).toBe("冲击·双爆");
  expect(score.weights[12103]).toBe(0.47);
  expect(score.discs[0]?.score).toBeCloseTo(3 / (6 + 1 + 0.75 + 0.47) * 55);
  expect(score.discs[1]).toEqual({ score: 1, grade: "C" });
  expect(score.discs[2]).toBeUndefined();
  expect(score.discs[3]?.score).toBeCloseTo((12 + 3 / (6 + 0.75 + 0.47 + 0.25) * 43) * 2 / 3);
  expect(score.discs[5]).toEqual({ score: 0, grade: "C" });
  expect(score.aggregate[0]).toMatchObject({ id: 20103, count: 6, weight: 1, value: "14.4%" });
  expect(score.useful).toBe(6);
  expect(score.effective).toBe(6);
});

test("空槽、未评分和确有零分是独立状态", () => {
  expect(buildZzzPanelScore({ ...avatar, equip: [] })).toBeUndefined();
  expect(buildZzzPanelScore({ ...avatar, equip: [disc(4, "S", 17)] })).toBeUndefined();
  const zero = buildZzzPanelScore({ ...avatar, id: 2011, name_mi18n: "哲", equip: [disc()] })!;
  expect(zero).toMatchObject({ total: 0, grade: "C", useful: 0, effective: 0, rule: "默认" });
  expect(zero.discs[0]).toEqual({ score: 0, grade: "C" });
  expect(zero.discs[1]).toBeUndefined();
});

test("单盘与总分沿用不同档位端点", () => {
  expect([0,12,12.001,20,28,32,36,40,48].map(zzzDiscScoreComment))
    .toEqual(["C","C","B","A","S","SS","SSS","ACE","MAX"]);
  expect([0,79.999,80,120,160,180,200,220,280].map(zzzPanelScoreComment))
    .toEqual(["C","C","B","A","S","SS","SSS","ACE","MAX"]);
});

test("角色独立权重与三项动态角色规则沿用旧面板", () => {
  const properties = [
    { property_name: "暴击率", final: "101%" },
    { property_name: "异常精通", final: "250" },
  ];
  const full = { ...avatar, properties, equip: [disc()] };
  expect(buildZzzPanelScore({ ...full, id: 1121, element_type: 201 })).toMatchObject({
    rule: "你没戴安全帽！", weights: { 13102: 0.5, 31603: 1 },
  });
  expect(buildZzzPanelScore({ ...full, id: 1401, element_type: 200 })).toMatchObject({
    rule: "直伤流", weights: { 31203: 0.5, 31503: 1 },
  });
  expect(buildZzzPanelScore({ ...full, id: 1331, rank: 4 })).toMatchObject({
    rule: "高影画", weights: { 21103: 0.25 },
  });
});
