import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { musicNumbers, musicPlatforms, musicQualities, type MusicPanelSettings, type MusicPanelSnapshot } from "./panel-music-schema.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "./yaml-source-edits.ts";

type Config = Readonly<Record<string, unknown>>;
type Patch = Partial<MusicPanelSettings>;
const defaults: MusicPanelSettings = { enable: true, default_platform: "netease", quality: "standard", search_limit: 10,
  session_timeout_ms: 120000, download_timeout_ms: 180000, max_size_mb: 128 };

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function numericValue(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max) return value;
}

function snapshot(document: Config): MusicPanelSnapshot {
  const music = record(document.music) ?? {};
  const settings = { ...defaults, enable: music.enable !== false,
    default_platform: musicPlatforms.find(({ value }) => value === music.default_platform)?.value ?? defaults.default_platform,
    quality: musicQualities.find(({ value }) => value === music.quality)?.value ?? defaults.quality };
  for (const { key } of musicNumbers) {
    const value = music[key];
    // Legacy validation also accepts valid integral YAML strings. Keep the source unless a user changes the setting.
    settings[key] = numericValue(typeof value === "string" ? Number(value) : value) ?? defaults[key];
  }
  return { settings, revision: createHash("sha256").update(JSON.stringify(settings)).digest("hex") };
}

function readChanges(value: unknown): Patch {
  const fields = record(value);
  if (!fields || !Object.keys(fields).length) throw new Error();
  const changes: Patch = {};
  for (const [key, input] of Object.entries(fields)) {
    if (key === "enable" && typeof input === "boolean") changes.enable = input;
    else if (key === "default_platform" && musicPlatforms.some(({ value }) => value === input)) {
      changes.default_platform = input as MusicPanelSettings["default_platform"];
    } else if (key === "quality" && musicQualities.some(({ value }) => value === input)) {
      changes.quality = input as MusicPanelSettings["quality"];
    } else {
      const field = musicNumbers.find(field => field.key === key);
      const number = numericValue(input, field && "max" in field ? field.max : undefined);
      if (!field || number === undefined) throw new Error();
      changes[field.key] = number;
    }
  }
  return changes;
}

function writeMusic(text: string, local: Config, effective: Config, changes: Patch) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const before = record(effective.music);
  if (effective.music !== undefined && !before) throw new GlobalConfigWriteError("config");
  const music = { ...before, ...changes };
  const source = isMap(yaml.contents) ? yaml.contents.get("music", true) : undefined;
  const edits: SourceEdit[] = [];
  if (isMap(source) || isAlias(source)) {
    const additions: Pair[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const existing = isMap(source) ? source.get(key, true) : undefined;
      const flow = JSON.stringify(value);
      if (isNode(existing)) edits.push(replaceSourceScalar(text, existing, flow));
      else additions.push({ key, flow, block: [`${key}: ${flow}`] });
    }
    if (additions.length) edits.push(isAlias(source) ? sourceAliasOverrides(text, source, additions)
      : insertSourcePairs(text, source, additions));
  } else {
    if (source !== undefined) throw new GlobalConfigWriteError("config");
    // The existing Media lookup inherits a whole music group, so carry it forward when first writing a local override.
    edits.push(insertSourcePairs(text, yaml.contents ?? undefined, [sourceMappingPair("music", music)]));
  }
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), { ...local, music })) throw new GlobalConfigWriteError("config");
  return result;
}

export function panelMusic(root: URL) {
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
          const yaml = writeMusic(text, local, effective, changes);
          return { yaml, value: snapshot({ music: { ...before.settings, ...changes } }) };
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
