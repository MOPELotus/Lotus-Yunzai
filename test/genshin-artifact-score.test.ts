import { expect, test } from "bun:test";
import { scoreArtifacts } from "../plugins/genshin/panel/artifact-score.ts";
import { officialPanel, readPanel, type PanelAvatar } from "../plugins/genshin/panel/model.ts";

const uid = "100123456";
const catalog = {
  characters: { "10000089": { name: "芙宁娜", elem: "hydro", star: 5 } },
  artifacts: new Map(),
  artifactSets: new Map([["黄金乐曲的变奏", "黄金剧团"], ["黄金之夜的喧嚣", "黄金剧团"]]),
};
const legacy = {
  uid,
  avatars: { "10000089": {
    id: 10000089, name: "芙宁娜", elem: "hydro", level: 90, cons: 6, _source: "enka",
    talent: { a: 8, e: 9, q: 10 }, weapon: { name: "静水流涌之辉", level: 90, promote: 6, affix: 1 },
    artis: {
      "1": { name: "黄金乐曲的变奏", level: 20, star: 5, mainId: 14001, attrIds: ["501224", "501224", "501204", "501034"] },
      "4": { name: "黄金之夜的喧嚣", level: 20, star: 5, mainId: 15011, attrIds: ["501224", "501204", "501204", "501241", "501023"] },
    },
  } },
};

const avatar = () => readPanel(uid, legacy, catalog, true)!.avatars["10000089"]!;

test("旧喵喵高命评分逐件匹配旧 ArtisMark，按五个位置计算总评级", () => {
  const result = scoreArtifacts(avatar());
  expect(result.rating?.title).toBe("芙宁娜-高命");
  expect(result.rating?.items["1"]?.score).toBeCloseTo(30.18437124039457, 10);
  expect(result.rating?.items["4"]?.score).toBeCloseTo(33.22666644177508, 10);
  expect(result.rating?.total).toBeCloseTo(63.41103768216965, 10);
  expect(result.rating?.rank).toBe("C");
  expect(result.rating?.weights.mastery?.weight).toBe(45);
  expect(result.rating?.items["3"]).toBeUndefined();
});

test("动态流派只用档案实际属性，未知主词条或副词条不产出总分", () => {
  const data = { ...avatar(), weapon: { name: "西风剑", promote: 6, affix: 1 } };
  expect(scoreArtifacts(data)).toEqual({ missing: "缺少角色最终属性 元素充能，请先更新面板" });
  const recharge = (value: string): PanelAvatar => ({ ...data, _lotus: { properties: [{ key: "recharge", value }] } });
  expect(scoreArtifacts(recharge("250%")).rating?.title).toBe("芙宁娜-西风纯辅");
  expect(scoreArtifacts(recharge("249%")).rating?.title).toBe("芙宁娜-高命");
  const piece = data.artis["1"]!;
  expect(scoreArtifacts({ ...data, artis: { "1": { ...piece, attrIds: ["999999"] } } }))
    .toEqual({ missing: "第 1 位圣遗物副词条无法识别" });
  expect(scoreArtifacts({ ...data, artis: { "1": { ...piece, mainId: 10 } } }))
    .toEqual({ missing: "第 1 位圣遗物词条不完整" });
});

test("米游社某件副词条数据不完整时仍保留原始显示值并停止评分", () => {
  const row = {
    base: { id: 10000089, level: 90, element: "Hydro", actived_constellation_num: 6 },
    weapon: { name: "静水流涌之辉", promote_level: 6, affix_level: 1 },
    skills: [{ skill_id: 1, skill_type: 1, level: 8 }],
    relics: [{ name: "黄金乐曲的变奏", pos: 1, rarity: 5, level: 20,
      main_property: { property_type: 2, value: "4780" },
      sub_property_list: [{ property_type: 20, value: "3.9%" }],
    }],
  };
  const data = officialPanel(uid, [row], catalog, 1000);
  expect(data.avatars["10000089"]?.artis["1"]).toMatchObject({
    scoreReady: false,
    properties: [{ key: "hpPlus", value: "4780" }, { key: "cpct", value: "3.9%" }],
  });
  const stored = readPanel(uid, JSON.parse(JSON.stringify(data)), catalog)!;
  expect(scoreArtifacts(stored.avatars["10000089"]!)).toEqual({ missing: "第 1 位圣遗物词条不完整" });
});
