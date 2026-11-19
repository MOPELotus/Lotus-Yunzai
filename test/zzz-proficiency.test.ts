import { expect, test } from "bun:test";
import type { ZzzPanelAvatar } from "../packages/hoyo-client/zzz-panel.ts";
import { zzzPanelCommand } from "../plugins/zzz/panel-command.ts";
import { buildZzzProficiency } from "../plugins/zzz/proficiency.ts";

function avatar(id: number, fields: Partial<ZzzPanelAvatar> = {}): ZzzPanelAvatar {
  return { id, name_mi18n: `代理人${id}`, level: 60, rank: 0, rarity: "S", avatar_profession: 1, element_type: 200, ...fields };
}

test("练度入口、展柜来源和档案后缀相互独立", () => {
  expect(zzzPanelCommand("%练度")).toEqual({ kind: "proficiency", profileId: 1, showcase: false });
  expect(zzzPanelCommand("#zzz练度统计 2")).toEqual({ kind: "proficiency", profileId: 2, showcase: false });
  expect(zzzPanelCommand("％绝区零展柜练度统计2")).toEqual({ kind: "proficiency", profileId: 2, showcase: true });
  for (const command of ["#练度", "#原神练度", "%练度0", "%练度256", "%练度统计 12345678", "%代查练度"]) {
    expect(zzzPanelCommand(command)).toBeUndefined();
  }
});

test("旧练度按盘分、等级、六项技能、影画、音擎等级及精炼计算并保持同分存档序", () => {
  const equal = [avatar(9994), avatar(9992)];
  const trained = avatar(9993, { level: 40, rank: 5,
    skills: [0, 1, 2, 3, 5, 6].map(skill_type => ({ skill_type, level: 10 })),
    weapon: { id: 14102, name: "钢铁肉垫", rarity: "A", level: 30, star: 2 },
    equip: [{ id: 31041, equipment_type: 1, level: 15, rarity: "S", name: "啄木鸟电音[1]",
      main_properties: [{ property_id: 11103, property_name: "生命值", base: "2200" }],
      properties: [
        { property_id: 20103, property_name: "暴击率", base: "14.4%" },
        { property_id: 21103, property_name: "暴击伤害", base: "4.8%" },
        { property_id: 12102, property_name: "攻击力", base: "3%" },
        { property_id: 23203, property_name: "穿透值", base: "9" },
      ] }],
  });
  const model = buildZzzProficiency([equal[0]!, trained, equal[1]!]);
  expect(model.rows.map(row => row.avatar.id)).toEqual([9993, 9994, 9992]);
  expect(model.rows[0]!.score).toBeCloseTo(2 * 55 + 60 * 5 + 40 * 2 + 5 * 5 * 2 + 30 * 2 + 2 * 4 * 2);
  expect(model.rows[0]!.skills).toEqual(Array(6).fill(10));
  expect(model).toMatchObject({ total: 3, agentS: 3, highRank: 1, highGrades: 1, sWeaponRate: 0 });
});

test("无音擎的比例缺省，与实际 0% 和已装备零分区分", () => {
  const empty = avatar(1111);
  const zero = avatar(2011, { rank: 0, equip: [{ id: 31041, equipment_type: 1, level: 0, rarity: "S", name: "啄木鸟电音[1]",
    main_properties: [{ property_id: 11103, property_name: "生命值", base: "0" }], properties: [] }] });
  const equipped = avatar(1112, { rarity: "A", weapon: { id: 12001, name: "月相", rarity: "B", level: 0, star: 0 } });
  expect(buildZzzProficiency([])).toMatchObject({ rows: [], total: 0, sWeaponRate: undefined });
  const result = buildZzzProficiency([empty, zero]);
  expect(result.sWeaponRate).toBeUndefined();
  expect(result.rows[0]).toMatchObject({ withDriveDiscs: false, driveDiscGrade: undefined, score: 120 });
  expect(result.rows[1]).toMatchObject({ withDriveDiscs: true, driveDiscGrade: "C", score: 120 });
  expect(buildZzzProficiency([empty, equipped]).sWeaponRate).toBe(0);
});
