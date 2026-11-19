import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderGenshinGachaSpecial } from "../plugins/genshin/gacha-special-card.ts";
import { buildGenshinGachaSpecial } from "../plugins/genshin/gacha-special.ts";
import { renderStarRailGachaSpecial } from "../plugins/starrail/gacha-special-card.ts";
import { buildStarRailGachaSpecial } from "../plugins/starrail/gacha-special.ts";

const uid = "100000002";
const model = buildStarRailGachaSpecial({
  uid, pool: "GachaType_Newbie",
  history: { uid, pools: { GachaType_Newbie: { totalDraws: 1 } } },
})!;

const genshin = buildGenshinGachaSpecial({
  uid, records: {}, type: "beginner",
  beginner: [{ id: "1000000000000000001", name: "诺艾尔", rank_type: "4", item_type: "角色", time: "2024-05-07 12:12:12" }],
})!;
const renderers = [
  ["星铁", (opts: Parameters<typeof renderStarRailGachaSpecial>[1]) => renderStarRailGachaSpecial(model, opts)],
  ["原神", (opts: Parameters<typeof renderGenshinGachaSpecial>[1]) => renderGenshinGachaSpecial(genshin, opts)],
] as const;

test.each(renderers)("%s 特殊池卡在渲染前要求真实的原主题目录并拒绝越界字体", async (game, render) => {
  const root = await mkdtemp(join(tmpdir(), "lotus-gacha-special-theme-"));
  const genshinResourceDirectory = join(root, "genshin");
  const themeDirectory = join(root, "miao");
  const opts = { mode: "gpu", genshinResourceDirectory, themeDirectory } as const;
  try {
    await expect(render(opts)).rejects.toThrow(`${game}特殊池记录的原 Genshin 资源目录不可用。`);

    const fonts = join(genshinResourceDirectory, "font");
    await mkdir(fonts, { recursive: true });
    await expect(render(opts)).rejects.toThrow(`${game}特殊池记录的原喵喵资源目录不可用。`);

    const outside = join(root, "outside.ttf");
    await mkdir(themeDirectory);
    await writeFile(outside, "outside-theme");
    await symlink(outside, join(fonts, "tttgbnumber.ttf"));
    await expect(render(opts)).rejects.toThrow(`${game}特殊池记录的原版字体不可用。`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("星铁特殊池卡拒绝无效缩放和超长图", async () => {
  await expect(renderStarRailGachaSpecial(model, { scale: 0 })).rejects.toThrow(RangeError);
  const tall = { ...model, pools: Array.from({ length: 100 }, () => model.pools[0]!) };
  await expect(renderStarRailGachaSpecial(tall)).rejects.toThrow("星铁特殊池记录超出可渲染高度。");
});
