import { expect, test } from "bun:test";
import { ProfileError } from "@lotus-yunzai/account";
import { lockFile } from "../lib/file-lock.ts";
import { createGenshinGrowQuery } from "../plugins/genshin/grow/command.ts";
import { resolveGrowthMaterials } from "../plugins/genshin/grow/catalogue.ts";
import type { GrowthCard } from "../plugins/genshin/grow/card.ts";
import { calculateCharacterGrowth, calculateWeaponGrowth, characterTarget, currentCharacter, matchGrowthCommand,
  publicCharacterGrowth, weaponTarget, type GrowthRequest, type ResolveMaterial } from "../plugins/genshin/grow/model.ts";

function parse(message: string): GrowthRequest {
  const request = matchGrowthCommand(message);
  if (!request || request === "help") throw new Error(`未解析养成测试指令 ${message}`);
  return request;
}

const materials = { gem: "最胜紫晶", boss: "雷光棱镜", specialty: "石珀", normal: "花蜜", talent: "繁荣", weekly: "北风之环",
  weapon: "远海夷地", monster: "混沌" };
const resolve: ResolveMaterial = (name, star) => name ? { label: `${name} ${star ?? 3}`, star: 3, icon: `${name}/${star ?? 3}` } : undefined;

test("旧原神角色成长等级、突破、经验与天赋保留实际旧样本数值", () => {
  expect(matchGrowthCommand("#原神养成计算")).toBe("help");
  expect(matchGrowthCommand("#星铁养成计算 刻晴")).toBeUndefined();
  const max = characterTarget(parse("#养成计算 刻晴"))!;
  const result = calculateCharacterGrowth(materials, publicCharacterGrowth, max, resolve);
  expect(result?.moraTotal).toBe(7_050_030);
  expect(result?.groups[0]?.desc).toBe("Lv.1 → Lv.90，需经验 8,362,650");
  expect(result?.groups[1]?.items.find(item => item.label === "智识之冕")?.num).toBe(3);
  const talents = characterTarget(parse("#原神培养计算 刻晴 天赋 10/9/10 档案2"))!;
  const leveling = calculateCharacterGrowth(materials, publicCharacterGrowth, talents, resolve);
  expect(leveling?.moraTotal).toBe(5_665_405);
  expect(leveling?.to).toEqual({ level: 80, promote: 6, a: 10, e: 9, q: 10 });
  expect(leveling?.groups[0]?.desc).toContain("天赋10级需突破至6阶");
  expect(calculateCharacterGrowth({ ...materials, weekly: undefined }, publicCharacterGrowth, talents, resolve)).toBeUndefined();
  expect(characterTarget(parse("#培养计算 刻晴 91"))).toBeUndefined();
  expect(currentCharacter({ level: 80, promote: 5 }, { a: 1, e: 1 })).toBeUndefined();
});

test("旧武器目标区分 80 和 80+，各星级上限与无须消耗有明确定义", () => {
  const level80 = weaponTarget(parse("#养成计算 雾切 80"), 5)!;
  const leveling = calculateWeaponGrowth(materials, 5, level80.from, level80.to, resolve);
  expect(leveling?.to).toEqual({ level: 80, promote: 5 });
  expect(leveling?.moraTotal).toBe(694_968);
  const plus = weaponTarget(parse("#原神养成计算 雾切 50-80+"), 5)!;
  expect(calculateWeaponGrowth(materials, 5, plus.from, plus.to, resolve)?.moraTotal).toBe(592_718);
  const already = weaponTarget(parse("#培养计算 雾切 80+-80+"), 5)!;
  expect(calculateWeaponGrowth({}, 5, already.from, already.to, () => undefined)).toMatchObject({ moraTotal: 0, groups: [{ items: [] }] });
  expect(weaponTarget(parse("#培养计算 新手长枪 80"), 1)).toBeUndefined();
});

test("材料系列按原目录查等级，缺一级资料不会用另一级代替", () => {
  const check = resolveGrowthMaterials({ 花蜜: { name: "原素花蜜", type: "normal", star: 3, items: {
    骗骗花蜜: { name: "骗骗花蜜", type: "normal", star: 1 },
  } } });
  expect(check("骗骗花蜜", 3)).toEqual({ label: "原素花蜜", star: 3, icon: "meta-gs/material/normal/原素花蜜.webp" });
  expect(check("原素花蜜", 2)).toBeUndefined();
  expect(check("未知材料")).toBeUndefined();
});

test("公开目标不读档案，当前角色练度只读自己的已绑 UID，换绑后不送出旧图", async () => {
  const uid = "100123456";
  let selected = uid;
  let uses = 0;
  let moveOnRender = false;
  let visible: GrowthCard | undefined;
  const query = createGenshinGrowQuery({ async savedRole(qq, number) {
    uses++;
    if (qq !== "42" || number !== 2) throw new ProfileError("missing", "测试无档案");
    return { uid: selected, region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true, nickname: "" };
  } }, lockFile, new AbortController().signal, {
    async loadCatalogue() {
      return { characters: new Map([["刻晴", { id: 10000042, name: "刻晴", abbr: "刻晴", rank: 5 as const, img: "meta-gs/character/刻晴/imgs/face.webp" }]]),
        weapons: new Map(), characterAliases: undefined, weaponAliases: undefined };
    },
    async loadTheme() {
      return { artifacts: new Map(), artifactSets: new Map(), characters: {}, async picture() { return undefined; },
        async metadata(_game, type) { return type === "character" ? { elem: "electro", materials } : {}; } };
    },
    archive: { async readPanel(qq, actual) {
      expect(qq).toBe("42");
      expect(actual).toBe(uid);
      return { uid, avatars: { 10000042: { id: 10000042, name: "刻晴", elem: "electro", level: 80, promote: 5,
        talent: { a: 7, e: 7, q: 7 }, artis: {}, _source: "mysPanel" } } };
    } },
    async render(model) {
      visible = model;
      if (moveOnRender) selected = "100123457";
      return { png: new Uint8Array([1]) };
    },
  });
  expect(await query("#养成计算 刻晴 80+-80+ 档案2", { user_id: 42 })).toMatchObject({ type: "image" });
  expect(uses).toBe(0);
  expect(visible?.uid).toBeUndefined();
  expect(await query("#养成计算 刻晴 等级80 100123457 档案2", { user_id: 42 })).toContain("绑定的原神角色不一致");
  expect(await query("#养成计算 刻晴 等级80 档案2", { user_id: 42 })).toMatchObject({ type: "image" });
  expect(visible?.uid).toBe(uid);
  expect(visible?.rows).toContainEqual({ title: "普攻", from: 7, to: 7 });
  moveOnRender = true;
  expect(await query("#养成计算 刻晴 等级80 档案2", { user_id: 42 })).toBe("原神档案角色已变化，请重新计算。");
});
