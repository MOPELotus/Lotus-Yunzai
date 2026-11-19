import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStarRailGachaDetail } from "../plugins/starrail/gacha-detail-card.ts";
import type { StarRailGachaDetailModel } from "../plugins/starrail/gacha-detail.ts";

const detail: StarRailGachaDetailModel = {
  uid: "100000002",
  face: { name: "测试开拓者" },
  poolName: "角色",
  gacha: {
    stat: { allNum: 10, noFiveNum: 10, noFourNum: 0, fiveNum: 0, fourNum: 0, fiveAvg: 0, fourAvg: 0, wai: 0,
      isvalidNum: 0, weaponNum: 0, weaponFourNum: 0, upYs: "0" },
    items: {},
    fiveLog: [],
    maxFour: { name: "无", count: 0 },
    noWaiRate: 0,
  },
};

test("星铁记录卡拒绝越界字体、缺少原主题和无效缩放比例", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-gacha-theme-"));
  try {
    const themeDirectory = join(root, "theme");
    await expect(renderStarRailGachaDetail(detail, { themeDirectory, mode: "gpu" }))
      .rejects.toThrow("星铁抽卡记录的原主题目录不可用。");
    await expect(renderStarRailGachaDetail(detail, { scale: 0, themeDirectory, mode: "gpu" }))
      .rejects.toThrow(RangeError);

    const fonts = join(themeDirectory, "common", "font");
    const outside = join(root, "outside.ttf");
    await mkdir(fonts, { recursive: true });
    await writeFile(outside, "outside-theme");
    await symlink(outside, join(fonts, "HYWH-65W.ttf"));
    await expect(renderStarRailGachaDetail(detail, { themeDirectory, mode: "gpu" }))
      .rejects.toThrow("星铁抽卡记录的原主题字体不可用。");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
