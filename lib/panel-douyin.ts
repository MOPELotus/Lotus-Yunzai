import { createHash } from "node:crypto";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { douyinDownloadNumbers, douyinPagePolicies, douyinQualities, type DouyinPanelSettings, type DouyinPanelSnapshot } from "./panel-douyin-schema.ts";
import { editMediaDownloadSettings, mediaDownloadSource } from "./panel-media-download-edit.ts";

type Config = Readonly<Record<string, unknown>>;
type Patch = Partial<DouyinPanelSettings>;
const defaults: DouyinPanelSettings = { enable: true, request_timeout_ms: 15000, download_enabled: true, quality: "adapt",
  duration_limit_seconds: 3600, video_size_limit_mb: 100, max_estimated_size_mb: 0, multi_page_policy: "zip", timeout_ms: 600000 };
const downloadKeys = ["enable", "quality", "multi_page_policy", "tools_path", ...douyinDownloadNumbers.map(({ key }) => key)];

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function int(value: unknown, min = 1): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min) return value;
}

function snapshot(document: Config): DouyinPanelSnapshot {
  const douyin = record(document.douyin) ?? {};
  const download = mediaDownloadSource(douyin);
  const settings: DouyinPanelSettings = {
    enable: douyin.enable === undefined || Boolean(douyin.enable),
    request_timeout_ms: int(Number(douyin.request_timeout_ms)) ?? defaults.request_timeout_ms,
    download_enabled: download.enable !== false,
    quality: douyinQualities.find(([value]) => value === download.quality)?.[0] ?? defaults.quality,
    duration_limit_seconds: int(Number(download.duration_limit_seconds ?? defaults.duration_limit_seconds), 0) ?? defaults.duration_limit_seconds,
    video_size_limit_mb: int(Number(download.video_size_limit_mb)) ?? defaults.video_size_limit_mb,
    max_estimated_size_mb: int(Number(download.max_estimated_size_mb), 0) ?? defaults.max_estimated_size_mb,
    multi_page_policy: douyinPagePolicies.find(([value]) => value === download.multi_page_policy)?.[0] ?? defaults.multi_page_policy,
    timeout_ms: int(Number(download.timeout_ms)) ?? defaults.timeout_ms,
  };
  return { settings, revision: createHash("sha256").update(JSON.stringify(settings)).digest("hex") };
}

function readChanges(value: unknown): Patch {
  const fields = record(value);
  if (!fields || !Object.keys(fields).length) throw new Error();
  const changes: Patch = {};
  for (const [key, input] of Object.entries(fields)) {
    if ((key === "enable" || key === "download_enabled") && typeof input === "boolean") changes[key] = input;
    else if (key === "multi_page_policy" && douyinPagePolicies.some(([policy]) => policy === input)) {
      changes.multi_page_policy = input as DouyinPanelSettings["multi_page_policy"];
    } else if (key === "quality" && douyinQualities.some(([quality]) => quality === input)) {
      changes.quality = input as DouyinPanelSettings["quality"];
    } else if (key === "request_timeout_ms") {
      const number = int(input);
      if (number === undefined) throw new Error();
      changes[key] = number;
    } else {
      const field = douyinDownloadNumbers.find(field => field.key === key);
      const number = field && int(input, field.min);
      if (!field || number === undefined) throw new Error();
      changes[field.key] = number;
    }
  }
  return changes;
}

export function panelDouyin(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(snapshot(await readLotusGlobalConfig(root))); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    let revision: string;
    let patch: Patch;
    try {
      const body = record(await readPanelJson(request, 4096));
      if (!body || Object.keys(body).length !== 2 || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/u.test(body.revision)) throw new Error();
      revision = body.revision;
      patch = readChanges(body.patch);
    } catch { return new Response(null, { status: 400 }); }

    const active = () => !request.signal.aborted && stillAuthorized();
    try {
      return Response.json(await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const before = snapshot(effective);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const changes: Patch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => before.settings[key as keyof Patch] !== value));
          if (!Object.keys(changes).length) return { value: before };
          const { enable, request_timeout_ms, download_enabled, ...downloads } = changes;
          const top = { ...(enable === undefined ? {} : { enable }), ...(request_timeout_ms === undefined ? {} : { request_timeout_ms }) };
          // In a flat old config, changing the parse switch would also change the effective download switch.
          const separate = enable !== undefined && !record(effective.douyin)?.download;
          const downloadSwitch = download_enabled ?? (separate ? before.settings.download_enabled : undefined);
          const download = Object.keys(downloads).length || downloadSwitch !== undefined
            ? { ...downloads, ...(downloadSwitch === undefined ? {} : { enable: downloadSwitch }) } : undefined;
          const { yaml, document } = editMediaDownloadSettings(text, local, effective, "douyin", downloadKeys, top, download);
          return { yaml, value: snapshot(document) };
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
