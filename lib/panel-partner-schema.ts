import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
export const partnerNumbers = [
  { key: "login_timeout_ms", label: $t("lib.panel-partner-schema.text_d1aec4bc04"), min: 1, max: 2_147_483_647 },
  { key: "login_poll_ms", label: $t("lib.panel-partner-schema.text_3587e44396"), min: 1, max: 2_147_483_647 },
  { key: "delay_ms_min", label: $t("lib.panel-partner-schema.text_9440d9ab44"), min: 0, max: 300000 },
  { key: "delay_ms_max", label: $t("lib.panel-partner-schema.text_64b9c010db"), min: 0, max: 300000 },
  { key: "review_max_chars", label: $t("lib.panel-partner-schema.text_531deee4c4"), min: 20, max: 500 },
  { key: "review_timeout_ms", label: $t("lib.panel-partner-schema.text_002c069f88"), min: 1, max: 2_147_483_647 },
] as const;

export const partnerScheduleDefault = "0 30 1 * * ? *";
export const partnerResponsesDefaultUrl = "https://api.openai.com/v1/responses";
export const partnerEditableReviewModes = ["fixed", "responses", "codex"] as const;
export type PartnerEditableReviewMode = typeof partnerEditableReviewModes[number];

export const partnerReviewModes = {
  fixed: $t("lib.panel-partner-schema.text_59c40d9247"), responses: $t("lib.panel-partner-schema.text_77830bbf0d"), codex: $t("lib.panel-partner-schema.text_affb9e9f87"), disabled: $t("lib.panel-partner-schema.text_3f9f2fe291"), unknown: $t("lib.panel-partner-schema.text_324aa2a7c6"),
} as const;

export interface PartnerPanelSettings {
  enable: boolean;
  schedule: string;
  auto_catch_up: boolean;
  notify_master: boolean;
  login_timeout_ms: number;
  login_poll_ms: number;
  delay_ms_min: number;
  delay_ms_max: number;
  comments: string[];
  review_max_chars: number;
  review_timeout_ms: number;
}

export interface PartnerPanelSnapshot {
  settings: PartnerPanelSettings;
  reviewMode: keyof typeof partnerReviewModes;
  review: {
    model: string;
    apiOrigin: string;
    apiUrlConfigured: boolean;
    apiKeyConfigured: boolean;
    customCodexCommand: boolean;
  };
  revision: string;
}
