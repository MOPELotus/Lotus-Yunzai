import { expect, test } from "bun:test";
import { projectLegacyMediaConfig } from "../lib/migration-media-config.ts";

test("keeps the active media settings and TuneWeave selection in legacy precedence", () => {
  const result = projectLegacyMediaConfig({ music: {}, douyin: { enable: false } }, [{
    bilibili: { search_limit: 4, duration_limit_seconds: 30, download: { enable: false, resolution: 80 } },
    music: { enable: true, default_platform: "netease" }, tuneweave: { request_timeout_ms: 4000 },
  }, {
    music: { enable: true }, douyin: { enable: true },
    tuneweave: { api_url: "http://127.0.0.1:7832/relay/", request_timeout_ms: 8000, update_delay_ms: 90000, old_token: "ignored" },
  }]);
  expect(result).toEqual({ config: {
    music: {}, douyin: { enable: false, download: { enable: false } },
    bilibili: { search_limit: 4, download: { enable: false, resolution: 80, duration_limit_seconds: 30 } },
    tuneweave: { api_url: "http://127.0.0.1:7832/relay/", request_timeout_ms: 8000, update_delay_ms: 90000 },
  }, deferred: [] });
  expect(projectLegacyMediaConfig({ tuneweave: {} }, [{ tuneweave: { api_url: "https://example.test" } }]))
    .toEqual({ config: { tuneweave: {} }, deferred: [] });
});

test("projects Bilibili camelCase download preferences and defers old executable directories", () => {
  const old = {
    bilibili: { resolution: "80", durationLimit: "70", videoSizeLimit: 90, maxSizeLimit: "45", multiPagePolicy: "all",
      video_size_limit_mb: 80, download: { duration_limit_seconds: 41, multi_page_policy: "first" } },
    external_tools: { toolsPath: "/legacy/untrusted/bin" },
  };
  expect(projectLegacyMediaConfig({}, [old])).toEqual({
    config: { bilibili: { download: { resolution: "80", duration_limit_seconds: 41, video_size_limit_mb: 80,
      max_estimated_size_mb: 45, multi_page_policy: "first" } } },
    deferred: ["bilibili.download.tools_path"],
  });
  expect(projectLegacyMediaConfig({
    bilibili: { durationLimit: "25", download: { tools_path: "data/tools/bin", max_estimated_size_mb: 0 } },
    external_tools: old.external_tools,
  }, [old])).toEqual({
    config: { bilibili: { download: { duration_limit_seconds: 25, max_estimated_size_mb: 0 } } },
    deferred: [],
  });
});

test("never changes the service origin when old settings conflict or contain URL credentials", () => {
  const source = (api_url: string) => ({ tuneweave: { api_url } });
  expect(() => projectLegacyMediaConfig({}, [source("https://one.example"), source("https://two.example")]))
    .toThrow("两处旧 TuneWeave 服务地址不一致");
  expect(projectLegacyMediaConfig({}, [source("https://one.example/"), source("https://one.example")]).config)
    .toEqual(source("https://one.example/"));
  for (const invalid of ["ftp://one.example", "https://user:password@one.example", "https://one.example/?token=credential"]) {
    expect(() => projectLegacyMediaConfig({}, [source(invalid)])).toThrow("旧 TuneWeave 服务地址无法安全沿用");
  }
});

test("holds executable and provider settings while retaining fixed review and download preferences", () => {
  const { config, deferred } = projectLegacyMediaConfig({}, [{
    tools: { dir: "/outside/tools", github_api: "https://unverified.example", timeout_ms: 7000,
      ffmpeg: { command: "/outside/custom-binary", asset_patterns: ["specific"] } },
    douyin: { enable: true, download: { tools_path: "/outside/bin", quality: "1080p" } },
    netease_partner: { enable: true, schedule: "5 0 * * *", comments: ["test"], review: {
      mode: "codex", api_key: "isolated-fixture", codex_command: "custom-command", max_chars: 80,
    } },
  }]);
  expect(config).toEqual({ tools: { timeout_ms: 7000 }, douyin: { enable: true, download: { quality: "1080p" } },
    netease_partner: { enable: false, schedule: "5 0 * * *", comments: ["test"], review: { mode: "disabled", max_chars: 80 } } });
  expect(deferred).toEqual(["douyin.download.tools_path", "netease_partner.enable", "netease_partner.review.api_key",
    "netease_partner.review.codex_command", "netease_partner.review.mode", "tools.dir",
    "tools.ffmpeg.asset_patterns", "tools.ffmpeg.command", "tools.github_api"]);
  expect(projectLegacyMediaConfig({}, [{ netease_partner: { enable: true, review: { mode: "fixed" } } }]))
    .toEqual({ config: { netease_partner: { enable: true, review: { mode: "fixed" } } }, deferred: [] });
});
