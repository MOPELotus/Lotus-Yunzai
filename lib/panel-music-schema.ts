export const musicPlatforms = [
  { value: "netease", label: "网易云" }, { value: "qq", label: "QQ音乐" }, { value: "kugou", label: "酷狗" },
  { value: "kuwo", label: "酷我" }, { value: "migu", label: "咪咕" }, { value: "soda", label: "汽水" },
] as const;

export const musicQualities = [
  { value: "auto", label: "自动选择" }, { value: "standard", label: "标准音质" }, { value: "higher", label: "较高音质" },
  { value: "high", label: "高品质" }, { value: "lossless", label: "无损音质" }, { value: "hires", label: "Hi-Res 高解析度" },
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
  { key: "search_limit", label: "每页歌曲数", max: 30 },
  { key: "session_timeout_ms", label: "选歌有效期（毫秒）" },
  { key: "download_timeout_ms", label: "音频下载超时（毫秒）" },
  { key: "max_size_mb", label: "音频体积上限（MiB）" },
] as const;

export interface MusicPanelSnapshot {
  revision: string;
  settings: MusicPanelSettings;
}
