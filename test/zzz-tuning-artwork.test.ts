import { expect, test } from "bun:test";
import type { ZzzTuningSnapshot } from "../packages/hoyo-client/index.ts";
import { createZzzTuningArtwork } from "../plugins/zzz/tuning-artwork.ts";

test("绝区零卡片只访问固定 QQ 头像和受信图标地址，失败图像可以省略", async () => {
  const records = [
    "https://act-webstatic.mihoyo.com/example.webp",
    "https://act-webstatic.mihoyo.com@example.invalid/image.webp",
    "http://127.0.0.1/image.webp",
    "https://upload-static.mihoyo.com/page.html",
    "",
    "https://act-webstatic.mihoyo.com/recovered.webp",
  ].map((icon, index) => ({
    itemId: String(Math.min(index + 1, 5)), name: `不在本地图鉴的夹具 ${index}`,
    icon, itemType: "CHARACTER", rarity: "S", isUp: false, upTag: "", count: 1, time: null,
    sort: String(index), version: "3.3",
  }));
  const stats: ZzzTuningSnapshot = {
    version: 1, uid: "100000002", profileId: 2, region: "prod_gf_cn", currentVersion: "3.3", updatedAt: "",
    inventory: {}, totalDraws: 6, totalS: 6, pools: [{
      type: "GACHA_TYPE_CHARACTER_UP", name: "独家频段", totalDraws: 6, totalS: 6, upCount: 0,
      averageUp: null, pity: 0, guaranteedWithin: null, records, periods: [],
    }],
  };
  const called: string[] = [];
  const image = Buffer.from([1, 2, 3]);
  const { avatar, resolveIcon, loadArtwork } = createZzzTuningArtwork(stats, "42", undefined, async (url, options) => {
    called.push(url.toString());
    expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(new Headers(options.headers).get("Cookie")).toBeNull();
    return new Response(image, { headers: { "Content-Type": url.pathname.endsWith(".html") ? "text/html" : "image/webp" } });
  });
  expect(await loadArtwork(avatar)).toEqual(image);
  const keys = records.map(record => resolveIcon(record)!);
  const paths = new Map<string, Buffer | undefined>();
  for (const key of new Set(keys)) paths.set(key, await loadArtwork(key));
  expect(keys.map(key => paths.get(key))).toEqual([image, undefined, undefined, undefined, image, image]);
  expect(called).toEqual([
    "https://q1.qlogo.cn/g?b=qq&nk=42&s=640",
    "https://act-webstatic.mihoyo.com/example.webp",
    "https://upload-static.mihoyo.com/page.html",
    "https://act-webstatic.mihoyo.com/recovered.webp",
  ]);
});
