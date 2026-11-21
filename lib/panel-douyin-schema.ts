export const douyinQualities = [
  ["adapt", "按发送大小选择"], ["4k", "4K"], ["2k", "2K"], ["1080p", "1080P"],
  ["720p", "720P"], ["540p", "540P"], ["360p", "360P"],
] as const;

export const douyinPagePolicies = [
  ["zip", "打包发送"], ["all", "逐项发送"], ["first", "只处理第一项"],
] as const;

export const douyinDownloadNumbers = [
  { key: "duration_limit_seconds", label: "视频时长限制（秒）", min: 0 },
  { key: "video_size_limit_mb", label: "视频消息体积上限（MiB）", min: 1 },
  { key: "max_estimated_size_mb", label: "作品下载体积上限（MiB）", min: 0 },
  { key: "timeout_ms", label: "下载超时（毫秒）", min: 1 },
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
