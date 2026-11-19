import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupGenshinBackpackMaterials } from "../plugins/genshin/backpack-materials.ts";
import { genshinBackpackProbe } from "../plugins/genshin/backpack-probe.ts";

test("缺本地素材时按官方材料 ID 保留旧背包分类和冠冕首位", async () => {
  const theme = await mkdtemp(join(tmpdir(), "lotus-backpack-theme-"));
  try {
    const rows = [
      ["104301", "「自由」的教导"], ["113005", "东风的吐息"], ["113011", "常燃火种"],
      ["101252", "海露花"], ["112002", "史莱姆清"], ["104113", "燃愿玛瑙块"],
      ["202", "摩拉"], ["114004", "高塔孤王的碎梦"], ["104319", "智识之冕"], ["113094", "未知的奖励"],
    ].map(([id, name]) => ({ id: id!, name: name!, count: 4, exact: true }));
    const { categories } = await groupGenshinBackpackMaterials(rows, theme, new AbortController().signal);
    expect(categories.map(({ items }) => items.map(it => it.name))).toEqual([
      ["摩拉"], ["海露花"], ["史莱姆清"], ["高塔孤王的碎梦"], ["智识之冕", "「自由」的教导"],
      ["燃愿玛瑙块"], ["常燃火种"], ["东风的吐息"], ["未知的奖励"],
    ]);
  } finally {
    await rm(theme, { recursive: true, force: true });
  }
});

test("扩展配方使用独立角色、官方元素和技能组，并保持对应武器等级", () => {
  const { items } = genshinBackpackProbe;
  expect(items.length).toBe(62);
  expect(new Set(items.map(item => item.avatar_id)).size).toBe(62);
  expect(items.filter(item => item.weapon).length).toBe(34);
  expect(items.find(({ avatar_id }) => avatar_id === 10000015)?.element_attr_id).toBe(7);
  expect(items.find(({ avatar_id }) => avatar_id === 10000015)?.skill_list.map(({ id }) => id)).toEqual([1531, 1532, 1539]);
});
