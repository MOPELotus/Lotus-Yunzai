export const mediaEnvironmentGroups = [
  { section: "tools", label: "工具链", fields: [
    { key: "tool_timeout_ms", field: "timeout_ms", label: "下载与解包单阶段超时（毫秒）", defaultValue: 300000, max: 2_147_483_647 },
    { key: "download_retries", field: "download_retries", label: "下载与解包总尝试次数", defaultValue: 3, max: Number.MAX_SAFE_INTEGER },
  ] },
  { section: "tuneweave", label: "TuneWeave 服务", fields: [
    { key: "request_timeout_ms", field: "request_timeout_ms", label: "接口请求超时（毫秒）", defaultValue: 30000, max: 2_147_483_647 },
    { key: "update_delay_ms", field: "update_delay_ms", label: "开机首次环境维护延迟（毫秒）", defaultValue: 180000, max: 2_147_483_647 },
  ] },
] as const;

type EnvironmentField = typeof mediaEnvironmentGroups[number]["fields"][number]["key"];
export type MediaEnvironmentSettings = Record<EnvironmentField, number>;
export interface MediaEnvironmentSnapshot {
  settings: MediaEnvironmentSettings;
  revision: string;
}
