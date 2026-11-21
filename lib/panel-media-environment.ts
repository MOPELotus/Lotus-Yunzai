import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { mediaEnvironmentGroups, type MediaEnvironmentSettings, type MediaEnvironmentSnapshot } from "./panel-media-environment-schema.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "./yaml-source-edits.ts";

type Config = Readonly<Record<string, unknown>>;
type Patch = Partial<MediaEnvironmentSettings>;
const fields = mediaEnvironmentGroups.flatMap(group => [...group.fields]);

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function positiveInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function snapshot(document: Config): MediaEnvironmentSnapshot {
  const settings = {} as MediaEnvironmentSettings;
  for (const group of mediaEnvironmentGroups) {
    const section = record(document[group.section]);
    for (const { key, field, defaultValue, max } of group.fields) {
      const configured = section?.[field];
      const number = typeof configured === "string" ? Number(configured) : configured;
      settings[key] = positiveInteger(number, max) ? number : defaultValue;
    }
  }
  return { settings, revision: createHash("sha256").update(JSON.stringify(settings)).digest("hex") };
}

function readChanges(value: unknown): Patch {
  const proposed = record(value);
  if (!proposed || !Object.keys(proposed).length) throw new Error();
  const patch: Patch = {};
  for (const [key, number] of Object.entries(proposed)) {
    const field = fields.find(field => field.key === key);
    if (!field || !positiveInteger(number, field.max)) throw new Error();
    patch[field.key] = number;
  }
  return patch;
}

function editEnvironment(text: string, local: Config, effective: Config, changes: Patch) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const root = yaml.contents ?? undefined;
  const edits: SourceEdit[] = [];
  const sections: Pair[] = [];
  const expected = { ...local };
  const updated = { ...effective };
  for (const group of mediaEnvironmentGroups) {
    const changed = group.fields.filter(({ key }) => changes[key] !== undefined);
    if (!changed.length) continue;
    const prior = record(effective[group.section]);
    const next = { ...prior, ...Object.fromEntries(changed.map(({ key, field }) => [field, changes[key]])) };
    expected[group.section] = updated[group.section] = next;
    const node = isMap(root) ? root.get(group.section, true) : undefined;
    if (!isNode(node)) {
      // Copy the existing effective group when it first becomes local so addresses and tool options keep the same source.
      sections.push(sourceMappingPair(group.section, next));
      continue;
    }
    if (!isMap(node) && !isAlias(node)) throw new GlobalConfigWriteError("config");
    const additions: Pair[] = [];
    for (const { field, key } of changed) {
      const old = isMap(node) ? node.get(field, true) : undefined;
      const flow = JSON.stringify(changes[key]);
      if (isNode(old)) edits.push(replaceSourceScalar(text, old, flow));
      else additions.push({ key: field, flow, block: [`${field}: ${flow}`] });
    }
    if (additions.length) edits.push(isAlias(node) ? sourceAliasOverrides(text, node, additions) : insertSourcePairs(text, node, additions));
  }
  // At a shared end offset the outer insertion is applied first; the inner fields then land before it.
  if (sections.length) edits.unshift(insertSourcePairs(text, isMap(root) ? root : undefined, sections));
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((source, edit) => source.slice(0, edit.start) + edit.value + source.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), expected)) throw new GlobalConfigWriteError("config");
  return { yaml: result, value: snapshot(updated) };
}

export function panelMediaEnvironment(root: URL) {
  // Use the actual settings reader, including its handling of multiple old TuneWeave endpoints.
  async function loadMediaEnvironment() {
    const { loadGlobalConfig } = await import("../plugins/media/core/config/global.ts");
    const { tools, tuneweave } = await loadGlobalConfig(root);
    return { tools, tuneweave };
  }
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(snapshot(await loadMediaEnvironment())); }
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
        canWrite: active, canCommit: active, signal: request.signal, resolveEffective: loadMediaEnvironment,
        prepare(text, local, effective) {
          const before = snapshot(effective);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const changes: Patch = {};
          for (const { key } of fields) {
            const next = patch[key];
            if (next !== undefined && before.settings[key] !== next) changes[key] = next;
          }
          return Object.keys(changes).length ? editEnvironment(text, local, effective, changes) : { value: before };
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
