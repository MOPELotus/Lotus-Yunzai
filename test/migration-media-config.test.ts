import { expect, test } from "bun:test";
import { projectLegacyMediaConfig } from "../lib/migration-media-config.ts";

test("keeps the active media settings and TuneWeave selection in legacy precedence", () => {
  const result = projectLegacyMediaConfig({ music: {}, douyin: { enable: false } }, [{
    bilibili: { search_limit: 4, duration_limit_seconds: 30, download: { enable: false, resolution: 80 } },
    music: { enable: true, default_platform: "netease" }, tuneweave: { request_timeout_ms: 4000 },
  }, {
    music: { enable: true }, douyin: { enable: true },
    tuneweave: { api_url: "http://127.0.0.1:7832/relay/", request_timeout_ms: 8000, old_token: "ignored" },
  }]);
  expect(result).toEqual({ config: {
    music: {}, douyin: { enable: false, download: { enable: false } },
    bilibili: { search_limit: 4, download: { enable: false, resolution: 80, duration_limit_seconds: 30 } },
    tuneweave: { api_url: "http://127.0.0.1:7832/relay/", request_timeout_ms: 8000 },
  }, deferred: [] });
  expect(projectLegacyMediaConfig({ tuneweave: {} }, [{ tuneweave: { api_url: "https://example.test" } }]))
    .toEqual({ config: { tuneweave: {} }, deferred: [] });
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
