import { expect, test } from "bun:test";
import type { ZzzPanelAvatar } from "../packages/hoyo-client/zzz-panel.ts";
import { zzzPanelCommand } from "../plugins/zzz/panel-command.ts";
import { buildZzzPanelDetail } from "../plugins/zzz/panel-detail.ts";

const avatar: ZzzPanelAvatar = { id: 1481, name_mi18n: "琉音", full_name_mi18n: "绮梦·琉音", level: 60, rarity: "S", rank: 0 };

test("角色详情沿用旧命令、可选档案后缀和更新/列表优先级", () => {
  expect(zzzPanelCommand("%琉音面板")).toEqual({ kind: "detail", profileId: 1, name: "琉音" });
  expect(zzzPanelCommand("#ZZZ客服面板2")).toEqual({ kind: "detail", profileId: 2, name: "客服" });
  expect(zzzPanelCommand("%琉音面板列表2")).toEqual({ kind: "list", profileId: 2 });
  expect(zzzPanelCommand("%更新琉音面板2")).toEqual({ kind: "update", profileId: 2, names: ["琉音"] });
  for (const command of ["琉音面板", "%琉音面板0", "%琉音面板999", "%更新展柜面板", "%展柜面板刷新", "% a\u0000面板"]) {
    expect(zzzPanelCommand(command)).toBeUndefined();
  }
});

test("旧档保留真实影画、技能顺序、属性拆分、改装、词条和驱动盘槽位", () => {
  const model = buildZzzPanelDetail({
    ...avatar, avatar_profession: 2, element_type: 200, sub_element_type: 4,
    role_vertical_painting_url: "https://example.com/role_vertical_painting_1481_442300.png",
    skills: [1, 2, 3, 4, 6, 0].map((type, index) => ({ skill_type: type, level: index === 5 ? 0 : index + 2 })),
    properties: [
      { property_id: 318, property_name: "电属性伤害加成", final: "95%" },
      { property_id: 2, property_name: "攻击力", base: 1471, add: "707", final: "2178" },
      { property_id: 315, property_name: "物理属性伤害加成", final: "0%" },
      { property_id: 1, property_name: "生命值", base: "8250", add: "5235", final: 13485 },
      { property_name: "暴击率", final: "<em>12%</em>" },
    ],
    weapon: { id: "14148", name: "昨夜来电", rarity: "S", level: 60, star: 0,
      main_properties: [{ property_id: 12101, property_name: "基础攻击力", base: 713 }],
      properties: [{ property_id: 20103, property_name: "暴击率", base: "24%" }] },
    equip: [{ id: 31646, name: "摇摆爵士[6]", rarity: "S", level: 15, equipment_type: "6",
      equip_suit: { suit_id: 31600 }, properties: [{ property_id: 20103, property_name: "暴击率", base: "7.2%", add: "2" }] },
    { id: 33242, name: "山大王[2]", rarity: "A", level: 0, equipment_type: 2 },
    { id: 31649, name: "越界项", equipment_type: 9 },
    { id: 31647, name: "重复项", equipment_type: 6 }],
  });
  expect(model).toMatchObject({ name: "绮梦·琉音", element: "HonedEdge", skinId: 442300, skills: [0, 3, 6, 2, 4, undefined] });
  expect(model.properties).toEqual([
    { id: 1, name: "生命值", base: "8250", added: "5235", value: "13485" },
    { id: 2, name: "攻击力", base: "1471", added: "707", value: "2178" },
    { id: 315, name: "物理属性伤害加成", base: undefined, added: undefined, value: "0%" },
  ]);
  expect(model.weapon).toMatchObject({ id: 14148, star: 0, main: [{ value: "713" }], extra: [{ value: "24%" }] });
  expect(model.discs.map(disc => disc?.id)).toEqual([undefined, 33242, undefined, undefined, undefined, 31646]);
  expect(model.discs[1]).toMatchObject({ level: 0, suitId: 33200 });
  expect(model.discs[5]).toMatchObject({ suitId: 31600, extra: [{ id: 20103, value: "7.2%", enhancements: 2 }] });
});

test("旧展柜特化角色显示对应属性，缺失的音擎和技能不补成零", () => {
  const stat = (name: string) => ({ property_name: name, final: 0 });
  const data = { ...avatar, element_type: 300, weapon: null,
    properties: ["攻击力", "贯穿力", "闪能自动累积", "锐暴伤害", "锐能自动累积", "穿透率", "能量自动回复"].map(stat) };
  const rupture = buildZzzPanelDetail({ ...data, avatar_profession: "6" });
  const specialty = buildZzzPanelDetail({ ...data, avatar_profession: 7 });
  expect(rupture.properties.map(stat => stat.name)).toEqual(["攻击力", "贯穿力", "闪能自动累积"]);
  expect(specialty.properties.map(stat => stat.name)).toEqual(["锐暴伤害", "穿透率", "锐能自动累积"]);
  expect(specialty.properties.map(stat => stat.value)).toEqual(["0", "0", "0"]);
  expect(specialty.skills).toEqual(Array(6).fill(undefined));
  expect(specialty.discs).toEqual(Array(6).fill(undefined));
  expect(specialty.weapon).toBeUndefined();
});
