export const biliResolutions = [
  [5, "144P 极省流"], [6, "240P 极速"], [16, "360P 流畅"], [32, "480P 清晰"],
  [48, "720P 兼容档"], [64, "720P 高清"], [74, "720P 60 帧"], [80, "1080P 高清"],
  [100, "智能修复"], [112, "1080P 高码率"], [116, "1080P 60 帧"], [120, "4K 超清"],
  [125, "HDR 真彩"], [126, "杜比视界"], [127, "8K 超高清"], [129, "HDR Vivid"],
] as const;

export const biliPagePolicies = [
  ["zip", "打包发送"], ["all", "全部下载"], ["first", "只下首 P"],
] as const;

export const biliDownloadNumbers = [
  { key: "concurrency", label: "下载并发", min: 1, max: 16 },
  { key: "duration_limit_seconds", label: "视频时长限制（秒）", min: 1 },
  { key: "video_size_limit_mb", label: "视频消息体积上限（MiB）", min: 1 },
  { key: "max_estimated_size_mb", label: "预估和下载体积上限（MiB）", min: 0 },
  { key: "timeout_ms", label: "下载超时（毫秒）", min: 1 },
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
