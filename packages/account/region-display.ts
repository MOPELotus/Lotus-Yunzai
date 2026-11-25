import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("account", messageCatalog.messages);
import type { Game } from "./index.ts";

const regionLabels: Readonly<Record<Game, ReadonlyMap<string, string>>> = {
  gs: new Map([
    ["cn_gf01", $t("region-display.text_6934e047bc")], ["cn_qd01", $t("region-display.text_04ed114576")],
    ["os_usa", $t("region-display.text_bc17e4cff9")], ["os_euro", $t("region-display.text_64b964d548")], ["os_asia", $t("region-display.text_72ff6e3218")], ["os_cht", $t("region-display.text_1ec27c8e85")],
  ]),
  sr: new Map([
    ["prod_gf_cn", $t("region-display.text_a0a78c9733")], ["prod_qd_cn", $t("region-display.text_25762cbb7b")],
    ["prod_official_usa", $t("region-display.text_bc17e4cff9")], ["prod_official_eur", $t("region-display.text_64b964d548")], ["prod_official_euro", $t("region-display.text_64b964d548")],
    ["prod_official_asia", $t("region-display.text_72ff6e3218")], ["prod_official_cht", $t("region-display.text_1ec27c8e85")],
  ]),
  zzz: new Map([
    ["prod_gf_cn", $t("region-display.text_a0a78c9733")], ["prod_qd_cn", $t("region-display.text_d526ff7388")],
    ["prod_gf_us", $t("region-display.text_bc17e4cff9")], ["prod_gf_eu", $t("region-display.text_64b964d548")], ["prod_gf_jp", $t("region-display.text_72ff6e3218")], ["prod_gf_sg", $t("region-display.text_1ec27c8e85")],
  ]),
};

export function gameRegionDisplayName(game: Game, region: string, ...reported: (string | undefined)[]) {
  const identifierPrefix = /^(?:cn_|os_|prod_)/iu;
  const name = reported.map(value => value?.trim()).find(value => value && !identifierPrefix.test(value));
  if (name) return name;
  const code = region.trim();
  return regionLabels[game].get(code.toLowerCase()) ?? (code && !identifierPrefix.test(code) ? code : $t("region-display.text_d27d31175b"));
}
