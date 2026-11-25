import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
export const biliResolutions = [
  [5, $t("lib.panel-bilibili-schema.text_6e187b33e6")], [6, $t("lib.panel-bilibili-schema.text_f6ed35128a")], [16, $t("lib.panel-bilibili-schema.text_4c9273ccad")], [32, $t("lib.panel-bilibili-schema.text_1fbfc170aa")],
  [48, $t("lib.panel-bilibili-schema.text_125a8ee553")], [64, $t("lib.panel-bilibili-schema.text_7fba0348eb")], [74, $t("lib.panel-bilibili-schema.text_61c02d26ec")], [80, $t("lib.panel-bilibili-schema.text_414b2a4156")],
  [100, $t("lib.panel-bilibili-schema.text_bd43abaf3c")], [112, $t("lib.panel-bilibili-schema.text_54ed0b548d")], [116, $t("lib.panel-bilibili-schema.text_d62a32881d")], [120, $t("lib.panel-bilibili-schema.text_ebbe4cb7a8")],
  [125, $t("lib.panel-bilibili-schema.text_0f2206faaa")], [126, $t("lib.panel-bilibili-schema.text_7963e073e1")], [127, $t("lib.panel-bilibili-schema.text_f39bb31142")], [129, "HDR Vivid"],
] as const;

export const biliPagePolicies = [
  ["zip", $t("lib.panel-bilibili-schema.text_f53576eaf9")], ["all", $t("lib.panel-bilibili-schema.text_0e148c6414")], ["first", $t("lib.panel-bilibili-schema.text_8455d25eb4")],
] as const;

export const biliDownloadNumbers = [
  { key: "concurrency", label: $t("lib.panel-bilibili-schema.text_645a1bede9"), min: 1, max: 16 },
  { key: "duration_limit_seconds", label: $t("lib.panel-bilibili-schema.text_d08c662b98"), min: 1 },
  { key: "video_size_limit_mb", label: $t("lib.panel-bilibili-schema.text_69d8e8941e"), min: 1 },
  { key: "max_estimated_size_mb", label: $t("lib.panel-bilibili-schema.text_0fd7e77134"), min: 0 },
  { key: "timeout_ms", label: $t("lib.panel-bilibili-schema.text_d724a1074b"), min: 1 },
] as const;

export interface BilibiliPanelSettings {
  search_limit: number;
  enable: boolean;
  concurrency: number;
  resolution: number;
  duration_limit_seconds: number;
  video_size_limit_mb: number;
  max_estimated_size_mb: number;
  multi_page_policy: typeof biliPagePolicies[number][0];
  timeout_ms: number;
}

export interface BilibiliPanelSnapshot {
  settings: BilibiliPanelSettings;
  revision: string;
}
