export const partnerNumbers = [
  { key: "login_timeout_ms", label: "扫码有效期（毫秒）", min: 1, max: 2_147_483_647 },
  { key: "login_poll_ms", label: "登录轮询间隔（毫秒）", min: 1, max: 2_147_483_647 },
  { key: "delay_ms_min", label: "最小操作间隔（毫秒）", min: 0, max: 300000 },
  { key: "delay_ms_max", label: "最大操作间隔（毫秒）", min: 0, max: 300000 },
  { key: "review_max_chars", label: "乐评字数上限", min: 20, max: 500 },
  { key: "review_timeout_ms", label: "AI 乐评超时（毫秒）", min: 1, max: 2_147_483_647 },
] as const;

export const partnerScheduleDefault = "0 30 1 * * ? *";
export const partnerResponsesDefaultUrl = "https://api.openai.com/v1/responses";
export const partnerEditableReviewModes = ["fixed", "responses", "codex"] as const;
export type PartnerEditableReviewMode = typeof partnerEditableReviewModes[number];

export const partnerReviewModes = {
  fixed: "固定评论库", responses: "Responses API 联网生成", codex: "本机 Codex CLI 联网生成", disabled: "迁移后等待本机确认", unknown: "未知配置",
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
