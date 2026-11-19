import { expect, test } from "bun:test";
import { buildArtifactList } from "../plugins/genshin/panel/artifact-list.ts";
import { matchGenshinPanel, type PanelAvatar } from "../plugins/genshin/panel/model.ts";
import type { PanelTheme } from "../plugins/genshin/panel/theme.ts";

const uid = "100123456";
const plainTheme: PanelTheme = { characters: {}, artifacts: new Map(), artifactSets: new Map(),
  async picture() { return undefined; } };
const gear = (name: string, mainId: number, attrIds: string[]) => ({
  name, set: "冒险家", level: 20, star: 5, mainId, attrIds,
});
const regular: PanelAvatar = {
  id: 10000042, name: "刻晴", elem: "electro", level: 90, promote: 6, cons: 0, _source: "enka",
  _lotus: { properties: [{ key: "mastery", value: "100" }] },
  talent: { a: 1, e: 1, q: 1 }, weapon: { name: "无锋剑", level: 90, promote: 6, affix: 1 },
  artis: {
    1: gear("花", 14001, ["501224"]),
    2: gear("羽", 12001, ["501084"]),
    3: gear("沙", 10004, ["501224", "501204"]),
    4: gear("杯", 15009, ["501224"]),
    5: gear("冠", 13007, ["501224", "501224"]),
  },
};

test("原神圣遗物列表识别旧 UID 和档案号，保留单角色圣遗物入口", () => {
  expect(matchGenshinPanel("#圣遗物列表")).toEqual({ type: "artifact-list", profileId: 1 });
  expect(matchGenshinPanel("#原神圣遗物列表100123456")).toEqual({ type: "artifact-list", profileId: 1, uid });
  expect(matchGenshinPanel("#圣遗物列表2")).toEqual({ type: "artifact-list", profileId: 2 });
  expect(matchGenshinPanel("#芙芙圣遗物2")).toMatchObject({ type: "detail", mode: "artifacts" });
  expect(matchGenshinPanel("#星铁遗器列表")).toBeUndefined();
});

test("复用旧版只命中主词条时的过滤与分数排序", async () => {
  const input = { uid, avatars: { 10000042: regular } };
  const list = await buildArtifactList(input, plainTheme);
  expect(list.eligible).toBe(5);
  expect(list.entries.map(row => row.slot).sort()).toEqual([1, 3, 4, 5]);
  expect(list.entries.map(row => row.rated.score)).toEqual(
    [...list.entries].map(row => row.rated.score).sort((left, right) => right - left),
  );
  expect(list.entries.find(row => row.slot === 5)?.rated.subs[0]?.rolls).toBe(2);
});

test("保留跨角色前 28 件，无法核对词条的角色不会混入排行", async () => {
  const ids = [[10000042, "刻晴"], [10000089, "芙宁娜"], [10000002, "神里绫华"],
    [10000022, "温迪"], [10000046, "胡桃"], [10000037, "甘雨"], [10000025, "行秋"], [10000052, "雷电将军"]] as const;
  const avatarProps = ["mastery", "hp", "recharge", "cpct", "cdmg"].map(key => ({ key, value: "100" }));
  const avatars = Object.fromEntries(ids.map(([id, name]) => [id, {
    ...regular, id, name, _lotus: { properties: avatarProps },
    artis: { ...regular.artis, 2: gear("羽", 12001, ["501224", "501204", "501054"]) },
  }]));
  const result = await buildArtifactList({ uid, avatars: { ...avatars,
    "10009999": { ...regular, id: 10009999, name: "资料缺失" },
  } }, plainTheme);
  expect(result.eligible).toBe(40);
  expect(result.entries).toHaveLength(28);
  expect(result.entries.every(row => row.avatar.id !== 10009999)).toBeTrue();
});

test("旧档评分缺的最终属性可用完整本地数值表复算，缺表继续排除", async () => {
  const a = { ...regular, id: 10000002, name: "神里绫华", elem: "cryo", _lotus: undefined };
  const snapshot = { uid, avatars: { 10000002: a } };
  expect(await buildArtifactList(snapshot, plainTheme)).toEqual({ eligible: 0, entries: [] });
  const theme: PanelTheme = { ...plainTheme, async metadata(_game, type) {
    return type === "character"
      ? { name: "神里绫华", weapon: "sword", attr: { keys: ["hp", "atk", "def", "cdmg"], details: { "80+": [1, 2, 3, 4], "90": [4, 5, 6, 7] } } }
      : { name: "无锋剑", attr: { atk: { "80+": 230, "90": 250 } } };
  } };
  expect((await buildArtifactList(snapshot, theme)).eligible).toBe(5);
});
