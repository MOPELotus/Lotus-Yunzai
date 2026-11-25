import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
export const douyinQualities = [
  ["adapt", $t("lib.panel-douyin-schema.text_c72b064d52")], ["4k", "4K"], ["2k", "2K"], ["1080p", "1080P"],
  ["720p", "720P"], ["540p", "540P"], ["360p", "360P"],
] as const;

export const douyinPagePolicies = [
  ["zip", $t("lib.panel-douyin-schema.text_f53576eaf9")], ["all", $t("lib.panel-douyin-schema.text_08d4a800f6")], ["first", $t("lib.panel-douyin-schema.text_0efad62762")],
] as const;

export const douyinDownloadNumbers = [
  { key: "duration_limit_seconds", label: $t("lib.panel-douyin-schema.text_d08c662b98"), min: 0 },
  { key: "video_size_limit_mb", label: $t("lib.panel-douyin-schema.text_69d8e8941e"), min: 1 },
  { key: "max_estimated_size_mb", label: $t("lib.panel-douyin-schema.text_63ddf23342"), min: 0 },
  { key: "timeout_ms", label: $t("lib.panel-douyin-schema.text_d724a1074b"), min: 1 },
] as const;

export interface DouyinPanelSettings {
  enable: boolean;
  request_timeout_ms: number;
  download_enabled: boolean;
  quality: typeof douyinQualities[number][0];
  duration_limit_seconds: number;
  video_size_limit_mb: number;
  max_estimated_size_mb: number;
  multi_page_policy: typeof douyinPagePolicies[number][0];
  timeout_ms: number;
}

export interface DouyinPanelSnapshot {
  settings: DouyinPanelSettings;
  revision: string;
}
