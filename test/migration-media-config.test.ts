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

test("preserves CLI review while keeping unrelated tools and provider settings deferred", () => {
  const { config, deferred } = projectLegacyMediaConfig({}, [{
    tools: { dir: "/outside/tools", github_api: "https://unverified.example", timeout_ms: 7000,
      ffmpeg: { command: "/outside/custom-binary", asset_patterns: ["specific"] } },
    douyin: { enable: true, download: { tools_path: "/outside/bin", quality: "1080p" } },
    netease_partner: { enable: true, schedule: "5 0 * * *", comments: ["test"], review: {
      mode: "codex", api_key: "isolated-fixture", codex_command: "custom-command", max_chars: 80,
    } },
  }]);
  expect(config).toEqual({ tools: { timeout_ms: 7000 }, douyin: { enable: true, download: { quality: "1080p" } },
    netease_partner: { enable: true, schedule: "5 0 * * *", comments: ["test"], review: { mode: "codex", max_chars: 80, codex_command: "custom-command" } } });
  expect(deferred).toEqual(["douyin.download.tools_path", "netease_partner.review.api_key",
    "netease_partner.review.codex_command.availability", "tools.dir",
    "tools.ffmpeg.asset_patterns", "tools.ffmpeg.command", "tools.github_api"]);
  expect(projectLegacyMediaConfig({}, [{ netease_partner: { enable: true, review: { mode: "fixed" } } }]))
    .toEqual({ config: { netease_partner: { enable: true, review: { mode: "fixed" } } }, deferred: [] });
});


test("CLI review survives migration with command/model preferences and explicit disabled state", () => {
  for (const command of ["codex", "/opt/CLI Tools/codex"]) {
    for (const enable of [true, false]) {
      const partner = { enable, notify_master: false, auto_catch_up: true, delay_ms_min: 8000, delay_ms_max: 11000,
        review: { mode: "codex", codex_command: command, model: "test-model", max_chars: 120, timeout_ms: 180000 } };
      const result = projectLegacyMediaConfig({}, [{ netease_partner: partner }]);
      expect(result.config.netease_partner).toEqual(partner);
      expect(result.deferred).toEqual(["netease_partner.review.codex_command.availability"]);
    }
  }
  expect(projectLegacyMediaConfig({ netease_partner: { enable: false, review: { mode: "codex", model: "" } } },
    [{ netease_partner: { enable: true, review: { mode: "fixed" } } }])).toEqual({
      config: { netease_partner: { enable: false, review: { mode: "codex" } } }, deferred: [],
    });
  expect(projectLegacyMediaConfig({}, [{ netease_partner: { review: { mode: "codex", codex_command: "" } } }]))
    .toEqual({ config: { netease_partner: { review: { mode: "codex" } } }, deferred: [] });
});

test("invalid CLI fields stop migration without silently selecting a different executable", () => {
  for (const field of ["codex_command", "model"]) {
    for (const value of [" ", " codex", "codex\nexec", "codex\0", 1, true]) {
      expect(() => projectLegacyMediaConfig({}, [{ netease_partner: { enable: true,
        review: { mode: "codex", [field]: value } } }])).toThrow("合伙人 CLI 乐评配置");
    }
  }
});

test("Responses review retains enabled state and provider settings during local migration", () => {
  const review = { mode: "responses", api_key: "synthetic-key", api_url: "https://fixture.invalid/v1/responses", model: "fixture-model", max_chars: 100, timeout_ms: 5000 };
  expect(projectLegacyMediaConfig({}, [{ netease_partner: { enable: true, review } }])).toEqual({ config: { netease_partner: { enable: true, review } }, deferred: [] });
  expect(projectLegacyMediaConfig({}, [{ netease_partner: { enable: false, review } }]).config.netease_partner).toEqual({ enable: false, review });
});
