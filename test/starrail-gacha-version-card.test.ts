import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStarRailGachaVersion } from "../plugins/starrail/gacha-version-card.ts";
import { buildStarRailGachaVersion } from "../plugins/starrail/gacha-version.ts";

const uid = "100000002";
const model = buildStarRailGachaVersion({
  uid, face: { name: "测试开拓者" }, type: "all", schedule: [],
  history: { uid, pools: { GachaType_Standard: { totalDraws: 1 } } },
})!;

test("星铁版本统计要求本地原主题并拒绝目录之外的字体", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-gacha-version-theme-"));
  try {
    const themeDirectory = join(root, "theme");
    const fonts = join(themeDirectory, "common", "font");
    const outside = join(root, "outside.ttf");
    await expect(renderStarRailGachaVersion(model, { mode: "gpu", themeDirectory }))
      .rejects.toThrow("星铁版本统计的原主题目录不可用。");
    await mkdir(fonts, { recursive: true });
    await writeFile(outside, "outside-theme");
    await symlink(outside, join(fonts, "tttgbnumber.ttf"));
    await expect(renderStarRailGachaVersion(model, { mode: "gpu", themeDirectory }))
      .rejects.toThrow("星铁版本统计的原主题字体不可用。");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("星铁版本统计在加载资源前拒绝无效缩放和超过上限的长图", async () => {
  await expect(renderStarRailGachaVersion(model, { scale: Number.NaN })).rejects.toThrow(RangeError);
  const tall = {
    ...model,
    gacha: { ...model.gacha, versionData: Array.from({ length: 400 }, () => model.gacha.versionData[0]!) },
  };
  await expect(renderStarRailGachaVersion(tall)).rejects.toThrow("星铁版本统计超出可渲染高度。");
});
