import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument, type Node } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { biliDownloadNumbers, biliPagePolicies, type BilibiliPanelSettings, type BilibiliPanelSnapshot } from "./panel-bilibili-schema.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "./yaml-source-edits.ts";

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

function downloadSource(bilibili: Config): Config {
  // Video commands still accept the older flat download fields when no nested download config is set.
  return bilibili.download ? record(bilibili.download) ?? {} : bilibili;
}

function snapshot(document: Config): BilibiliPanelSnapshot {
  const bilibili = record(document.bilibili) ?? {};
  const download = downloadSource(bilibili);
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

function writeBilibili(text: string, local: Config, effective: Config, changes: Patch) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const prior = record(effective.bilibili) ?? {};
  if (effective.bilibili !== undefined && !record(effective.bilibili)) throw new GlobalConfigWriteError("config");
  const { search_limit, ...downloadChanges } = changes;
  const hasDownloadChanges = Object.keys(downloadChanges).length > 0;
  const download = record(prior.download) ?? Object.fromEntries(downloadKeys.filter(key => Object.hasOwn(downloadSource(prior), key))
    .map(key => [key, downloadSource(prior)[key]]));
  const bilibili = { ...prior, ...(search_limit === undefined ? {} : { search_limit }),
    ...(hasDownloadChanges ? { download: { ...download, ...downloadChanges } } : {}) };
  const edits: SourceEdit[] = [];
  function insert(node: Node | undefined, additions: Pair[]) {
    if (!additions.length) return;
    if (isAlias(node)) edits.push(sourceAliasOverrides(text, node, additions));
    else if (node === undefined || isMap(node)) edits.push(insertSourcePairs(text, node, additions));
    else throw new GlobalConfigWriteError("config");
  }
  function writeScalars(node: Node, values: Config, additions: Pair[]) {
    for (const [key, value] of Object.entries(values)) {
      const source = isMap(node) ? node.get(key, true) : undefined;
      const flow = JSON.stringify(value);
      if (isNode(source)) edits.push(replaceSourceScalar(text, source, flow));
      else additions.push({ key, flow, block: [`${key}: ${flow}`] });
    }
  }
  const source = isMap(yaml.contents) ? yaml.contents.get("bilibili", true) : undefined;
  if (!isNode(source)) {
    insert(yaml.contents ?? undefined, [sourceMappingPair("bilibili", bilibili)]);
  } else {
    const additions: Pair[] = [];
    if (search_limit !== undefined) writeScalars(source, { search_limit }, additions);
    if (hasDownloadChanges) {
      const nested = isMap(source) ? source.get("download", true) : undefined;
      if (isMap(nested) || isAlias(nested)) {
        const nestedAdditions: Pair[] = [];
        writeScalars(nested, downloadChanges, nestedAdditions);
        insert(nested, nestedAdditions);
      } else if (isNode(nested)) {
        if (prior.download) throw new GlobalConfigWriteError("config");
        edits.push(replaceSourceScalar(text, nested, JSON.stringify(bilibili.download)));
      } else additions.push(sourceMappingPair("download", bilibili.download!));
    }
    insert(source, additions);
  }
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), { ...local, bilibili })) throw new GlobalConfigWriteError("config");
  return { yaml: result, value: snapshot({ bilibili }) };
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
          return writeBilibili(text, local, effective, changes);
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
