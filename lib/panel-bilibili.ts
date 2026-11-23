import { createHash } from "node:crypto";
import { compatibleBilibiliDownload } from "./bilibili-download-compat.ts";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { biliDownloadNumbers, biliPagePolicies, type BilibiliPanelSettings, type BilibiliPanelSnapshot } from "./panel-bilibili-schema.ts";
import { editMediaDownloadSettings } from "./panel-media-download-edit.ts";

type Config = Readonly<Record<string, unknown>>;
type Patch = Partial<BilibiliPanelSettings>;
const defaults: BilibiliPanelSettings = { search_limit: 10, enable: true, concurrency: 4, resolution: 64,
  duration_limit_seconds: 3600, video_size_limit_mb: 100, max_estimated_size_mb: 0, multi_page_policy: "zip", timeout_ms: 600000 };
const downloadKeys = [...Object.keys(defaults).filter(key => key !== "search_limit"), "tools_path"];

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function int(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max) return value;
}

function snapshot(document: Config): BilibiliPanelSnapshot {
  const bilibili = record(document.bilibili) ?? {};
  const download = compatibleBilibiliDownload(bilibili);
  const settings: BilibiliPanelSettings = {
    search_limit: int(Number(bilibili.search_limit)) ?? defaults.search_limit,
    enable: download.enable !== false,
    concurrency: Math.max(1, Math.min(16, Math.floor(Number(download.concurrency) || defaults.concurrency))),
    resolution: int(Number(download.resolution)) ?? defaults.resolution,
    duration_limit_seconds: int(Number(download.duration_limit_seconds)) ?? defaults.duration_limit_seconds,
    video_size_limit_mb: int(Number(download.video_size_limit_mb)) ?? defaults.video_size_limit_mb,
    max_estimated_size_mb: int(Number(download.max_estimated_size_mb), 0) ?? defaults.max_estimated_size_mb,
    multi_page_policy: biliPagePolicies.find(([value]) => value === download.multi_page_policy)?.[0] ?? defaults.multi_page_policy,
    timeout_ms: int(Number(download.timeout_ms)) ?? defaults.timeout_ms,
  };
  return { settings, revision: createHash("sha256").update(JSON.stringify(settings)).digest("hex") };
}

function readChanges(value: unknown): Patch {
  const fields = record(value);
  if (!fields || !Object.keys(fields).length) throw new Error();
  const changes: Patch = {};
  for (const [key, input] of Object.entries(fields)) {
    if (key === "enable" && typeof input === "boolean") changes.enable = input;
    else if (key === "multi_page_policy" && biliPagePolicies.some(([policy]) => policy === input)) {
      changes.multi_page_policy = input as BilibiliPanelSettings["multi_page_policy"];
    } else if (key === "search_limit" || key === "resolution") {
      const number = int(input);
      if (number === undefined) throw new Error();
      changes[key] = number;
    } else {
      const field = biliDownloadNumbers.find(field => field.key === key);
      const number = field && int(input, field.min, "max" in field ? field.max : undefined);
      if (!field || number === undefined) throw new Error();
      changes[field.key] = number;
    }
  }
  return changes;
}

export function panelBilibili(root: URL) {
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
          const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => before.settings[key as keyof Patch] !== value));
          if (!Object.keys(changes).length) return { value: before };
          const { search_limit, ...download } = changes;
          const { yaml, document } = editMediaDownloadSettings(text, local, effective, "bilibili", downloadKeys,
            search_limit === undefined ? {} : { search_limit }, Object.keys(download).length ? download : undefined);
          return { yaml, value: snapshot(document) };
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
