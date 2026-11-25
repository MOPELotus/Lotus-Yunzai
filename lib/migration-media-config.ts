import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { compatibleBilibiliDownload } from "./bilibili-download-compat.ts";

type Fields = Readonly<Record<string, unknown>>;

const sections = ["tools", "tuneweave", "bilibili", "douyin", "music", "netease_partner"] as const;
const downloadKeys = ["enable", "duration_limit_seconds", "video_size_limit_mb",
  "max_estimated_size_mb", "multi_page_policy", "timeout_ms"] as const;

function fields(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
}

function scalars(value: Fields, keys: readonly string[]) {
  return Object.fromEntries(keys.flatMap(key => {
    const item = value[key];
    return typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)
      ? [[key, item]] : [];
  }));
}

function endpoint(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** Projects supported settings without executing tools or forwarding provider credentials to another service. */
export function projectLegacyMediaConfig(current: Fields, legacy: readonly Fields[]) {
  const config: Record<string, unknown> = {};
  const deferred = new Set<string>();
  for (const key of sections) {
    const historical = legacy.filter(item => Object.hasOwn(item, key));
    const history = historical.map(item => fields(item[key]));
    const currentHasSection = Object.hasOwn(current, key);
    if (!currentHasSection && !history.length) continue;
    let source = currentHasSection ? fields(current[key]) : history[0]!;
    if (key === "tuneweave" && !currentHasSection) {
      const configured = history.filter(item => endpoint(item.api_url));
      const urls = new Set(configured.map(item => endpoint(item.api_url).replace(/\/+$/u, "")));
      if (urls.size > 1) throw new Error($t("lib.migration-media-config.text_8152bfd88d"));
      source = configured[0] ?? source;
    }

    switch (key) {
      case "tools": {
        const result = scalars(source, ["timeout_ms", "download_retries"]);
        const defaults = { dir: "data/tools", bin_dir: "data/tools/bin", github_api: "https://api.github.com" };
        for (const [field, expected] of Object.entries(defaults)) {
          if (source[field] && source[field] !== expected) deferred.add("tools." + field);
        }
        const ffmpeg = fields(source.ffmpeg);
        for (const [field, expected] of Object.entries({ repo: "BtbN/FFmpeg-Builds", command: "ffmpeg" })) {
          if (ffmpeg[field] && ffmpeg[field] !== expected) deferred.add("tools.ffmpeg." + field);
        }
        if (Array.isArray(ffmpeg.asset_patterns) && ffmpeg.asset_patterns.length) deferred.add("tools.ffmpeg.asset_patterns");
        config[key] = result;
        break;
      }
      case "tuneweave": {
        const result = scalars(source, ["request_timeout_ms", "update_delay_ms"]);
        const address = endpoint(source.api_url);
        if (address) {
          const url = URL.parse(address);
          if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
              url.search || url.hash || address.trim() !== address) {
            throw new Error($t("lib.migration-media-config.text_27fbcdcdf2"));
          }
          result.api_url = address;
        }
        config[key] = result;
        break;
      }
      case "bilibili":
      case "douyin": {
        const billi = key === "bilibili";
        const hasDownload = Object.hasOwn(source, "download") && source.download && typeof source.download === "object";
        const nested = fields(source.download);
        const settings = billi ? compatibleBilibiliDownload(source, { ...source, ...nested }) : hasDownload ? nested : source;
        const download = scalars(settings, [...downloadKeys, ...(billi ? ["concurrency", "resolution"] : ["quality"])]);
        const oldTools = billi ? fields((currentHasSection ? current : historical[0])?.external_tools).toolsPath : undefined;
        const toolsPath = Object.hasOwn(settings, "tools_path") ? settings.tools_path : oldTools;
        if (toolsPath && toolsPath !== "data/tools/bin") deferred.add(key + ".download.tools_path");
        config[key] = {
          ...scalars(source, billi ? ["search_limit"] : ["enable", "request_timeout_ms"]),
          ...(hasDownload || Object.keys(download).length ? { download } : {}),
        };
        break;
      }
      case "music":
        config[key] = scalars(source, ["enable", "default_platform", "quality", "search_limit",
          "session_timeout_ms", "download_timeout_ms", "max_size_mb"]);
        break;
      case "netease_partner": {
        const settings = scalars(source, ["enable", "auto_catch_up", "notify_master", "schedule",
          "login_timeout_ms", "login_poll_ms", "delay_ms_min", "delay_ms_max"]);
        const review = fields(source.review);
        const externalReview = review.mode === "responses";
        const reviewSettings = scalars(review, ["mode", "max_chars", "timeout_ms"]);
        if (review.mode === "codex") {
          for (const field of ["codex_command", "model"] as const) {
            const value = review[field];
            // Empty settings retain the runtime's PATH/default-model behavior.
            if (value == null || value === "") continue;
            if (typeof value !== "string" || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
              throw new Error($t("lib.migration-media-config.invalid_cli_setting", { field }));
            }
            reviewSettings[field] = value;
          }
          if (reviewSettings.codex_command) deferred.add("netease_partner.review.codex_command.availability");
        }
        for (const field of review.mode === "codex" ? ["api_key", "api_url"] : ["codex_command", "api_key", "api_url", "model"]) {
          if (review[field]) deferred.add("netease_partner.review." + field);
        }
        if (externalReview) {
          deferred.add("netease_partner.review.mode");
          if (source.enable === true) deferred.add("netease_partner.enable");
          settings.enable = false;
          reviewSettings.mode = "disabled";
        }
        config[key] = {
          ...settings,
          ...(Array.isArray(source.comments) ? { comments: source.comments.filter(item => typeof item === "string") } : {}),
          ...(Object.keys(reviewSettings).length ? { review: reviewSettings } : {}),
        };
        break;
      }
    }
  }
  return { config, deferred: [...deferred].sort() };
}
