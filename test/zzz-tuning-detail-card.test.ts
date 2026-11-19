import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderZzzTuningDetail } from "../plugins/zzz/tuning-detail-card.ts";
import type { ZzzTuningDetailModel } from "../plugins/zzz/tuning-detail.ts";

const model: ZzzTuningDetailModel = {
  uid: "100000002", nickname: "测试绳匠", avatar: "avatar:fixture", data: [],
};

test("绝区零调频在加载头像之前验证原主题路径和字体边界", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-gacha-theme-"));
  const themeDirectory = join(root, "theme");
  let artworkLoads = 0;
  const options = {
    mode: "gpu", themeDirectory,
    async loadArtwork() { artworkLoads++; return undefined; },
  } as const;
  try {
    await expect(renderZzzTuningDetail(model, options)).rejects.toThrow("绝区零调频的原版主题目录不可用。");
    const fonts = join(themeDirectory, "common", "fonts");
    await mkdir(fonts, { recursive: true });
    const outside = join(root, "outside.ttf");
    await writeFile(outside, "outside-theme");
    await symlink(outside, join(fonts, "inpinhongmengti.ttf"));
    await expect(renderZzzTuningDetail(model, options)).rejects.toThrow("绝区零调频的原版字体不可用。");
    expect(artworkLoads).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("绝区零调频拒绝无效缩放和超过画布上限的长图", async () => {
  await expect(renderZzzTuningDetail(model, { scale: 0.5 })).rejects.toThrow(RangeError);
  const tall: ZzzTuningDetailModel = {
    ...model, data: [{
      type: "GACHA_TYPE_CHARACTER_UP", name: "独家频段", timeRange: "", lastFive: 0, fiveStars: 800, upCount: 0,
      totalCount: 800, avgFive: "1", avgUp: "-", avgUpEstimated: false, noWai: "-", noWaiEstimated: false,
      level: 2, tag: "平稳保底", emoji: 16,
      list: Array.from({ length: 800 }, (_, index) => ({
        itemId: String(index + 1), name: "测试角色", square_icon: "", isUp: false, totalCount: "1", color: "white", version: "2.1",
      })),
    }],
  };
  await expect(renderZzzTuningDetail(tall)).rejects.toThrow("绝区零调频统计超出可渲染高度。");
});
