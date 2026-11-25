import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
export const mediaEnvironmentGroups = [
  { section: "tools", label: $t("lib.panel-media-environment-schema.text_4faf856ef0"), fields: [
    { key: "tool_timeout_ms", field: "timeout_ms", label: $t("lib.panel-media-environment-schema.text_13511811fc"), defaultValue: 300000, max: 2_147_483_647 },
    { key: "download_retries", field: "download_retries", label: $t("lib.panel-media-environment-schema.text_68f184c2ad"), defaultValue: 3, max: Number.MAX_SAFE_INTEGER },
  ] },
  { section: "tuneweave", label: $t("lib.panel-media-environment-schema.text_3600ed22aa"), fields: [
    { key: "request_timeout_ms", field: "request_timeout_ms", label: $t("lib.panel-media-environment-schema.text_68f768644b"), defaultValue: 30000, max: 2_147_483_647 },
    { key: "update_delay_ms", field: "update_delay_ms", label: $t("lib.panel-media-environment-schema.text_58dd391e11"), defaultValue: 0, max: 2_147_483_647 },
  ] },
] as const;

type EnvironmentField = typeof mediaEnvironmentGroups[number]["fields"][number]["key"];
export type MediaEnvironmentSettings = Record<EnvironmentField, number>;
export interface MediaEnvironmentSnapshot {
  settings: MediaEnvironmentSettings;
  revision: string;
}
