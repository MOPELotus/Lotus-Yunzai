type Config = Readonly<Record<string, unknown>>;

const aliasKeys = {
  resolution: "resolution",
  duration_limit_seconds: "durationLimit",
  video_size_limit_mb: "videoSizeLimit",
  max_estimated_size_mb: "maxSizeLimit",
  multi_page_policy: "multiPagePolicy",
} as const;

function record(value: unknown): Config {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Config : {};
}

/** Resolves public download preferences without making a legacy executable path active. */
export function compatibleBilibiliDownload(config: Config, source: Config = config.download ? record(config.download) : config): Config {
  const compatibility: Record<string, unknown> = {};
  for (const [key, alias] of Object.entries(aliasKeys)) {
    if (Object.hasOwn(source, key)) continue;
    if (Object.hasOwn(config, key)) {
      compatibility[key] = config[key];
      continue;
    }
    const value = config[alias];
    if (key === "multi_page_policy") {
      if (value === "first" || value === "all" || value === "zip") compatibility[key] = value;
      continue;
    }
    const number = typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(number) && (key === "max_estimated_size_mb" ? number >= 0 : number > 0)) {
      compatibility[key] = number;
    }
  }
  return Object.keys(compatibility).length ? { ...source, ...compatibility } : source;
}
