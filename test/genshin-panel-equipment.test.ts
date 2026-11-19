import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileRequestContext } from "../packages/account/index.ts";
import { lockFile } from "../lib/file-lock.ts";
import { estimatePanelDamage, readChangedPanelProperties } from "../plugins/genshin/panel/damage.ts";
import { buildEquipmentChange } from "../plugins/genshin/panel/equipment-change.ts";
import { matchGenshinPanel, readPanel } from "../plugins/genshin/panel/model.ts";
import { createGenshinPanelQuery } from "../plugins/genshin/panel/panel.ts";
import type { PanelTheme } from "../plugins/genshin/panel/theme.ts";

const uid = "100123456";
const otherUid = "100654321";
const theme: PanelTheme = {
  characters: {
    10000002: { name: "神里绫华", abbr: "绫华", weapon: "sword", elem: "cryo" },
    10000046: { name: "胡桃", weapon: "polearm", elem: "pyro" },
    10000089: { name: "芙宁娜", abbr: "芙芙", weapon: "sword", elem: "hydro" },
    10000999: { name: "尚无规则的角色", weapon: "sword", elem: "geo" },
  },
  artifacts: new Map(), artifactSets: new Map(),
  async metadata(...parts) {
    if (parts[1] === "weapon" && parts[2] === "sword") {
      return { name: parts[3], attr: { atk: { "80+": 600, "90": 620 } } };
    }
    if (parts[1] === "character" && parts[2] === "尚无规则的角色") {
      return { name: "尚无规则的角色", weapon: "sword", attr: { keys: ["hp","atk","def","recharge"],
        details: { "80+": [1000, 100, 200, 20], "90": [1100, 110, 210, 25] } } };
    }
    return {};
  },
  async picture() { return undefined; },
};
const weapon = (name: string) => ({ name, level: 90, promote: 6, affix: 1 });
const piece = (set: string, name: string) => ({ name, set, star: 5, level: 20, attrIds: ["501204"], mainId: 14001 });
const profile = (id: number, name: string, assignedWeapon: string) =>
  ({ id, name, _source: "enka", level: 90, promote: 6, cons: 0, talent: { a: 9, e: 9, q: 9 }, weapon: weapon(assignedWeapon) });
const four = piece("冰风迷途的勇士", "遍结寒霜的傲骨");
const original = { uid, avatars: {
  10000089: { ...profile(10000089, "芙宁娜", "静水流涌之辉"), artis: { 4: piece("黄金剧团","黄金之夜的喧嚣") },
    _lotus: { properties: [{ key: "hp", value: "77777" }] } },
  10000002: { ...profile(10000002, "神里绫华", "雾切之回光"), artis: { 4: four } },
  10000046: profile(10000046, "胡桃", "护摩之杖"),
  10000999: { ...profile(10000999, "尚无规则的角色", "西风剑"), artis: { 4: four } },
} };

test("临时换装沿旧语序兼容武器、五槽、伤害序号与档案", () => {
  expect(matchGenshinPanel("#芙芙面板换绫华武器")).toMatchObject({
    type: "change", profileId: 1, name: "芙芙", mode: "profile", equipmentChange: { donor: "绫华", slot: "weapon" },
  });
  expect(matchGenshinPanel("#UID:100123456芙芙伤害2换绫华100123456杯子 档案2")).toMatchObject({
    type: "change", profileId: 2, uid, mode: "damage", damageRow: 2, equipmentChange: { donor: "绫华", donorUid: uid, slot: "4" },
  });
  for (const [position, slot] of [["花", "1"], ["死之羽", "2"], ["沙漏", "3"], ["空之杯", "4"], ["礼冠", "5"]] as const) {
    expect(matchGenshinPanel(`#芙芙换绫华${position}`)?.equipmentChange?.slot).toBe(slot);
  }
  for (const message of ["#星铁黄泉面板换流萤武器", "#芙芙面板换绫华2武器", "#芙芙面板换绫华武器换胡桃花",
    "#芙芙面板换绫华武器 档案256", "#芙芙换西风剑"]) expect(matchGenshinPanel(message)).toBeUndefined();
});

test("同档试装克隆装备，丢弃旧派生属性，对无规则角色只报可证实的基础属性", async () => {
  const snapshot = readPanel(uid, original, theme, true)!;
  const target = snapshot.avatars["10000089"]!;
  const changed = await buildEquipmentChange(snapshot, target, { donor: "绫华", slot: "4" }, theme);
  expect(changed).toMatchObject({ equipped: four.name, avatar: { _source: "change", _lotus: undefined, artis: { 4: four } } });
  if (!("avatar" in changed)) throw new Error("未生成试装");
  expect(changed.avatar.artis[4]).not.toBe(snapshot.avatars["10000002"]?.artis[4]);
  expect(target._lotus?.properties?.[0]?.value).toBe("77777");
  expect(target.artis[4]?.set).toBe("黄金剧团");
  expect(await buildEquipmentChange(snapshot, target, { donor: "胡桃", slot: "weapon" }, theme)).toMatchObject({ message: expect.stringContaining("武器种类") });
  expect(await buildEquipmentChange(snapshot, target, { donor: "绫华", slot: "5" }, theme)).toMatchObject({ message: expect.stringContaining("指定位置") });
  expect(await buildEquipmentChange(snapshot, target, { donor: "绫华", donorUid: otherUid, slot: "4" }, theme))
    .toMatchObject({ message: expect.stringContaining("所选档案") });

  const noRule = await buildEquipmentChange(snapshot, snapshot.avatars["10000999"]!, { donor: "绫华", slot: "weapon" }, theme);
  if (!("avatar" in noRule)) throw new Error("未生成试装");
  expect(await estimatePanelDamage(noRule.avatar, theme)).toMatchObject({ message: expect.stringContaining("没有这个角色的伤害规则") });
  expect(await readChangedPanelProperties(noRule.avatar, theme)).toEqual([
    { key: "hp", base: "1100", value: "" }, { key: "atk", base: "730.0", value: "" }, { key: "def", base: "210.0", value: "" },
  ]);
});

test("临时换装拒绝跨绑来源、查询期间换绑并且不写原档、预设或群榜", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-genshin-equipment-"));
  const legacyDirectory = join(dir, "old");
  const archiveDirectory = join(dir, "new");
  await mkdir(legacyDirectory);
  const oldJson = JSON.stringify(original);
  const path = join(legacyDirectory, uid + ".json");
  await writeFile(path, oldJson);
  const otherJson = JSON.stringify({ ...original, uid: otherUid });
  const otherPath = join(legacyDirectory, otherUid + ".json");
  await writeFile(otherPath, otherJson);
  let swapped = false, rebindOnRender = false, marks = 0, fetches = 0;
  const role = (id: number) => ({ uid: id === 2 && !swapped ? uid : otherUid, nickname: "", gameBiz: "hk4e_cn", region: "cn_gf01", chosen: true });
  const png = Buffer.from("trial");
  try {
    const query = createGenshinPanelQuery({
      async savedRole(_, id) { return role(id); },
      async requestContext(qq, profileId, game) {
        return { qq, profileId, game, role: role(profileId), revision: swapped ? "changed" : "before" } as ProfileRequestContext;
      },
    }, { async fetchGenshinPanel() { fetches++; throw Error("unexpected automatic request"); } },
    lockFile, new AbortController().signal, {
      archiveDirectory, legacyDirectory, theme: async () => theme,
      groupRank: { allows() { return true; }, async observe() { marks++; } },
      render: {
        async list() { throw Error("unexpected list"); },
        async detail(_, avatar, _theme, options) {
          expect(avatar.weapon?.name).toBe("雾切之回光");
          expect(avatar._source).toBe("change");
          expect(options?.change?.equipped).toBe("雾切之回光");
          expect(avatar._lotus?.properties?.find(row => row.value === "77777")).toBeUndefined();
          if (rebindOnRender) swapped = true;
          return { png };
        },
      },
    });
    expect(await query("#芙芙面板换绫华武器 档案2", { user_id: 42, group_id: 77 })).toEqual({ type: "image", file: png });
    expect(await query(`#芙芙面板换${otherUid}绫华武器 档案2`, { user_id: 42 })).toContain("本次所选档案");
    expect(await query(`#${uid}芙芙面板换绫华武器`, { user_id: 42 })).toContain("当前档案绑定");
    rebindOnRender = true;
    expect(await query("#芙芙面板换绫华武器 档案2", { user_id: 42, group_id: 77 })).toContain("档案已变化");
    expect(marks).toBe(0);
    expect(fetches).toBe(0);
    expect(await readFile(path, "utf8")).toBe(oldJson);
    expect(await readFile(otherPath, "utf8")).toBe(otherJson);
    expect(await stat(archiveDirectory).catch(() => undefined)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
