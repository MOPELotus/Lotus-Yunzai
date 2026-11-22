import { expect, test } from "bun:test";
import { gameRegionDisplayName } from "./region-display.ts";

test("三款游戏的区服标识按官方地区对应到可读名称", () => {
  expect(gameRegionDisplayName("gs", "cn_gf01")).toBe("天空岛");
  expect(gameRegionDisplayName("gs", "cn_qd01")).toBe("世界树");
  expect(gameRegionDisplayName("gs", "os_cht")).toBe("港澳台服");
  expect(gameRegionDisplayName("sr", "prod_qd_cn")).toBe("国服 B 服");
  expect(gameRegionDisplayName("sr", "prod_official_eur")).toBe("欧服");
  expect(gameRegionDisplayName("sr", "prod_official_euro")).toBe("欧服");
  expect(gameRegionDisplayName("zzz", "prod_qd_cn", "prod_gf_cn")).toBe("渠道服");
  expect(gameRegionDisplayName("zzz", "prod_gf_sg")).toBe("港澳台服");
});

test("显示保留有效名称和世等，跳过历史档案中的区服键", () => {
  expect(gameRegionDisplayName("zzz", "prod_gf_cn", "新艾利都")).toBe("新艾利都");
  expect(gameRegionDisplayName("sr", "prod_official_usa", "prod_official_asia")).toBe("美服");
  expect(gameRegionDisplayName("gs", "cn_future01")).toBe("未知区服");
  expect(gameRegionDisplayName("zzz", "绳网等级 60")).toBe("绳网等级 60");
});
