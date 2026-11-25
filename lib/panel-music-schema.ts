import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
export const musicPlatforms = [
  { value: "netease", label: $t("lib.panel-music-schema.text_06afc99e7d") }, { value: "qq", label: $t("lib.panel-music-schema.text_3ef42060a2") }, { value: "kugou", label: $t("lib.panel-music-schema.text_6f5fe8042a") },
  { value: "kuwo", label: $t("lib.panel-music-schema.text_2a6eaaa1f3") }, { value: "migu", label: $t("lib.panel-music-schema.text_017e2d4515") }, { value: "soda", label: $t("lib.panel-music-schema.text_e8b8acde12") },
] as const;

export const musicQualities = [
  { value: "auto", label: $t("lib.panel-music-schema.text_db9773faa3") }, { value: "standard", label: $t("lib.panel-music-schema.text_890130437f") }, { value: "higher", label: $t("lib.panel-music-schema.text_3c1c586996") },
  { value: "high", label: $t("lib.panel-music-schema.text_88eb9bf8a3") }, { value: "lossless", label: $t("lib.panel-music-schema.text_0252c5164b") }, { value: "hires", label: $t("lib.panel-music-schema.text_395fbda43c") },
] as const;

export interface MusicPanelSettings {
  enable: boolean;
  default_platform: typeof musicPlatforms[number]["value"];
  quality: typeof musicQualities[number]["value"];
  search_limit: number;
  session_timeout_ms: number;
  download_timeout_ms: number;
  max_size_mb: number;
}

export const musicNumbers = [
  { key: "search_limit", label: $t("lib.panel-music-schema.text_116bc5acf8"), max: 30 },
  { key: "session_timeout_ms", label: $t("lib.panel-music-schema.text_b8e04b2db4") },
  { key: "download_timeout_ms", label: $t("lib.panel-music-schema.text_c581b37f8d") },
  { key: "max_size_mb", label: $t("lib.panel-music-schema.text_cdea0df15b") },
] as const;

export interface MusicPanelSnapshot {
  revision: string;
  settings: MusicPanelSettings;
}
