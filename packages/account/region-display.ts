import type { Game } from "./index.ts";

const regionLabels: Readonly<Record<Game, ReadonlyMap<string, string>>> = {
  gs: new Map([
    ["cn_gf01", "天空岛"], ["cn_qd01", "世界树"],
    ["os_usa", "美服"], ["os_euro", "欧服"], ["os_asia", "亚服"], ["os_cht", "港澳台服"],
  ]),
  sr: new Map([
    ["prod_gf_cn", "国服"], ["prod_qd_cn", "国服 B 服"],
    ["prod_official_usa", "美服"], ["prod_official_eur", "欧服"], ["prod_official_euro", "欧服"],
    ["prod_official_asia", "亚服"], ["prod_official_cht", "港澳台服"],
  ]),
  zzz: new Map([
    ["prod_gf_cn", "国服"], ["prod_qd_cn", "渠道服"],
    ["prod_gf_us", "美服"], ["prod_gf_eu", "欧服"], ["prod_gf_jp", "亚服"], ["prod_gf_sg", "港澳台服"],
  ]),
};

export function gameRegionDisplayName(game: Game, region: string, ...reported: (string | undefined)[]) {
  const identifierPrefix = /^(?:cn_|os_|prod_)/iu;
  const name = reported.map(value => value?.trim()).find(value => value && !identifierPrefix.test(value));
  if (name) return name;
  const code = region.trim();
  return regionLabels[game].get(code.toLowerCase()) ?? (code && !identifierPrefix.test(code) ? code : "未知区服");
}
