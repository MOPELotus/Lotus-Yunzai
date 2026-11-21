import { expect, test } from "bun:test";
import { normalizeZzzPanelAvatar } from "@lotus-yunzai/hoyo-client";
import { buildZzzPanelRankRow, zzzPanelRankCommand } from "../plugins/zzz/panel-rank-model.ts";
import { zzzPanelCommand } from "../plugins/zzz/panel-command.ts";

test("绝区零角色榜保留旧别名和档案尾号，个人面板独立", () => {
  const first = { kind: "board", name: "安比", weighted: false, profileId: 1, page: 1 } as const;
  for (const command of ["%安比排名", "%安比面板排名", "%安比驱动盘排行", "%安比圣遗物", "%安比驱动盘"]) {
    expect(zzzPanelRankCommand(command)).toEqual(first);
  }
  expect(zzzPanelRankCommand("#绝区零11号综合榜2 页8")).toEqual({ ...first, name: "11号", weighted: true, profileId: 2, page: 8 });
  expect(zzzPanelRankCommand("%安比排名123456789")).toBeUndefined();
  expect(zzzPanelRankCommand("%安比面板")).toBeUndefined();
  expect(zzzPanelCommand("%安比面板")?.kind).toBe("detail");
  expect(zzzPanelRankCommand("%显示角色面板排名2")).toEqual({ kind: "visibility", enable: true, profileId: 2 });
  expect(zzzPanelRankCommand("%取消显示群内角色面板排名")).toEqual({ kind: "visibility", enable: false, profileId: 1 });
});

test("普通榜使用同一个旧驱动盘积分，综合榜保留音擎、职业和最多三种套装", () => {
  const base = { id: 1011, name_mi18n: "安比", rank: 2, rarity: "A", level: 60, avatar_profession: 2, element_type: 203,
    properties: [
      { property_id: 121, property_name: "攻击力", base: "1000", final: "1770", add: "770" },
      { property_id: 201, property_name: "暴击率", base: "5%", final: "25%", add: "20%" },
      { property_id: 211, property_name: "暴击伤害", base: "50%", final: "80%", add: "30%" },
    ],
    skills: [0, 1, 2, 3, 5, 6].map((skill_type, index) => ({ skill_type, level: index + 6 })), ranks: [] };
  const equip = [1, 2, 3, 4].map(slot => ({
    id: 31040 + slot, name: "合成驱动盘", level: 15, rarity: "S", equipment_type: slot,
    main_properties: [{ property_id: 11103, property_name: "生命值", base: "2200" }],
    properties: [{ property_id: 20103, property_name: "暴击率", base: "7.2%" }],
    equip_suit: [{ suit_id: 100 + slot }, { id: 102 }],
  }));
  const weapon = { id: 14101, name: "合成音擎", rarity: "A", level: 60, star: 4, profession: 2 };
  const calculate = (item: typeof weapon | undefined) => buildZzzPanelRankRow(normalizeZzzPanelAvatar({ ...base, equip, weapon: item }));
  const loaded = calculate(weapon);
  // Fixed archives 2057599 / e28c6df return 75.91240875912409 and 100.91240875912409.
  expect(loaded.drive).toBeCloseTo(75.91240875912409, 10);
  expect(loaded.weighted).toBeCloseTo(100.91240875912409, 10);
  expect(loaded.skills).toEqual([6, 8, 11, 7, 9, 10]);
  const without = calculate(undefined);
  expect(without.weighted).toBe(without.drive);
  const disconnected = calculate({ ...weapon, rarity: "S", profession: 1, level: 30, star: 1 });
  expect(disconnected.weighted - disconnected.drive).toBe(19);
});
