import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument, type Node } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { atlasScopeChanges, atlasScopeSnapshot, parseAtlasScopePatch, replaceAtlasScope, UnsupportedAtlasScope } from "./panel-atlas-scopes.ts";
import { type AtlasScopeField, type AtlasScopePatch } from "./panel-atlas-scope-schema.ts";
import { readPanelJson } from "./panel.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair } from "./yaml-source-edits.ts";

const defaults = { check_cron: "0 0 */6 * * ? *", challenge_cron: "0 15 */2 * * ? *" };
const cronFields = ["check_cron", "challenge_cron"] as const;
type Settings = typeof defaults & { enable: boolean; run_on_missing_data: boolean };
type ProposedSettings = Omit<Settings, "run_on_missing_data"> & Partial<Pick<Settings, "run_on_missing_data">>;
type Config = Readonly<Record<string, unknown>>;
type Parser = typeof import("../plugins/atlas/update-policy.ts").parseAtlasUpdatePolicy;
type SearchSettings = typeof import("../plugins/atlas/search-limit.ts");

class InvalidAtlasCron extends Error {
  constructor(readonly field: typeof cronFields[number]) { super(); }
}

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function snapshot(document: Config, parsePolicy?: Parser, search?: SearchSettings) {
  const atlas = record(document.atlas);
  const auto = record(atlas?.auto_update);
  const settings: Settings = {
    enable: atlas !== undefined && (atlas.auto_update === undefined || auto !== undefined) &&
      (auto?.enable === undefined || auto.enable === true),
    check_cron: typeof auto?.check_cron === "string" ? auto.check_cron : defaults.check_cron,
    challenge_cron: typeof auto?.challenge_cron === "string" ? auto.challenge_cron : defaults.challenge_cron,
    run_on_missing_data: auto?.run_on_missing_data === undefined || auto.run_on_missing_data === true,
  };
  const revision = createHash("sha256").update(JSON.stringify([settings, atlas?.update_args, atlas?.challenge_args, atlas?.max_results])).digest("hex");
  return { settings, revision, scopes: parsePolicy && atlasScopeSnapshot(atlas, parsePolicy),
    searchLimit: search && (search.parseAtlasSearchLimit(atlas?.max_results) ?? search.defaultAtlasSearchLimit) };
}

function writeSettings(text: string, local: Config, effective: Config, changes: Partial<Settings>, args: AtlasScopePatch, searchLimit?: number) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const prior = record(effective.atlas) ?? {};
  const auto = record(prior.auto_update) ?? {};
  if ((effective.atlas !== undefined && !record(effective.atlas)) ||
      (prior.auto_update !== undefined && !record(prior.auto_update))) throw new GlobalConfigWriteError("config");
  // Atlas fields are inherited as a group. Preserve the effective old fields when first creating a local section.
  const scheduleChanged = Object.keys(changes).length > 0;
  const autoUpdate = { ...auto, ...changes };
  const atlas = { ...prior, ...args, ...(searchLimit !== undefined && { max_results: searchLimit }),
    ...(scheduleChanged && { auto_update: autoUpdate }) };
  const atlasNode = isMap(yaml.contents) ? yaml.contents.get("atlas", true) : undefined;
  const autoNode = isMap(atlasNode) ? atlasNode.get("auto_update", true) : undefined;
  const insert = (node: Node | undefined, pairs: Pair[]) => {
    if (isAlias(node)) return sourceAliasOverrides(text, node, pairs);
    if (node !== undefined && !isMap(node)) throw new GlobalConfigWriteError("config");
    return insertSourcePairs(text, node, pairs);
  };
  const edits = [];
  if (!isNode(atlasNode)) {
    edits.push(insert(yaml.contents ?? undefined, [sourceMappingPair("atlas", atlas)]));
  } else {
    const additions: Pair[] = [];
    for (const [key, value] of Object.entries(args) as [AtlasScopeField, readonly string[]][]) {
      const source = isMap(atlasNode) ? atlasNode.get(key, true) : undefined;
      const flow = JSON.stringify(value);
      if (isNode(source)) edits.push(replaceAtlasScope(text, source, key, flow));
      else additions.push({ key, flow, block: [`${key}: ${flow}`] });
    }
    if (searchLimit !== undefined) {
      const source = isMap(atlasNode) ? atlasNode.get("max_results", true) : undefined;
      const flow = String(searchLimit);
      if (isNode(source)) edits.push(replaceSourceScalar(text, source, flow));
      else additions.push({ key: "max_results", flow, block: [`max_results: ${flow}`] });
    }
    if (scheduleChanged && !isNode(autoNode)) additions.push(sourceMappingPair("auto_update", autoUpdate));
    if (additions.length) edits.push(insert(atlasNode, additions));
    if (scheduleChanged && isNode(autoNode)) {
      const scheduleFields: Pair[] = [];
      for (const [key, value] of Object.entries(changes)) {
        const source = isMap(autoNode) ? autoNode.get(key, true) : undefined;
        const flow = JSON.stringify(value);
        if (isNode(source)) edits.push(replaceSourceScalar(text, source, flow));
        else scheduleFields.push({ key, flow, block: [`${key}: ${flow}`] });
      }
      if (scheduleFields.length) edits.push(insert(autoNode, scheduleFields));
    }
  }
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), { ...local, atlas })) throw new GlobalConfigWriteError("config");
  return { yaml: result, atlas };
}

export function panelAtlasUpdate(root: URL, validModuleCron: (cron: string) => boolean) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try {
        const [parser, search] = await Promise.all([import("../plugins/atlas/update-policy.ts").catch(() => undefined),
          import("../plugins/atlas/search-limit.ts").catch(() => undefined)]);
        return Response.json(snapshot(await readLotusGlobalConfig(root), parser?.parseAtlasUpdatePolicy, search));
      }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    let revision: string;
    let proposed: ProposedSettings;
    let scopePatch: AtlasScopePatch;
    let proposedLimit: number | undefined;
    try {
      const body = record(await readPanelJson(request, 4096));
      const settings = record(body?.settings);
      if (!body || Object.keys(body).some(key => !["revision", "settings", "scopePatch", "searchLimit"].includes(key)) ||
          typeof body.revision !== "string" || !/^[a-f0-9]{64}$/u.test(body.revision) ||
          !settings || Object.keys(settings).length !== (Object.hasOwn(settings, "run_on_missing_data") ? 4 : 3) ||
          typeof settings.enable !== "boolean" ||
          (Object.hasOwn(settings, "run_on_missing_data") && typeof settings.run_on_missing_data !== "boolean") ||
          typeof settings.check_cron !== "string" || settings.check_cron.length > 160 ||
          typeof settings.challenge_cron !== "string" || settings.challenge_cron.length > 160) throw new Error();
      revision = body.revision;
      scopePatch = Object.hasOwn(body, "scopePatch") ? parseAtlasScopePatch(body.scopePatch) : {};
      if (Object.hasOwn(body, "searchLimit")) {
        if (typeof body.searchLimit !== "number") return Response.json({ field: "searchLimit" }, { status: 400 });
        proposedLimit = body.searchLimit;
      }
      proposed = { enable: settings.enable, check_cron: settings.check_cron, challenge_cron: settings.challenge_cron,
        run_on_missing_data: settings.run_on_missing_data as boolean | undefined };
    } catch { return new Response(null, { status: 400 }); }

    let parsePolicy: Parser;
    let search: SearchSettings;
    try {
      // The builtin may be absent before bootstrap. Load its parser only when editing its configuration.
      const [update, searchSettings] = await Promise.all([import("../plugins/atlas/update-policy.ts"), import("../plugins/atlas/search-limit.ts")]);
      parsePolicy = update.parseAtlasUpdatePolicy;
      search = searchSettings;
    } catch { return new Response(null, { status: 503 }); }
    if (proposedLimit !== undefined && search.parseAtlasSearchLimit(proposedLimit) === undefined) {
      return Response.json({ field: "searchLimit" }, { status: 400 });
    }

    const active = () => !request.signal.aborted && stillAuthorized();
    try {
      return Response.json(await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const before = snapshot(effective, parsePolicy, search);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const changes: Partial<Settings> = {};
          if (before.settings.enable !== proposed.enable) changes.enable = proposed.enable;
          if (proposed.run_on_missing_data !== undefined && proposed.run_on_missing_data !== before.settings.run_on_missing_data) {
            changes.run_on_missing_data = proposed.run_on_missing_data;
          }
          for (const key of cronFields) {
            if (before.settings[key] === proposed[key]) continue;
            const normalized = proposed[key].trim() || defaults[key];
            if (normalized !== before.settings[key]) changes[key] = normalized;
          }
          const args = atlasScopeChanges(scopePatch, before.scopes!, parsePolicy);
          const searchLimit = proposedLimit === before.searchLimit ? undefined : proposedLimit;
          if (!Object.keys(changes).length && !Object.keys(args).length && searchLimit === undefined) return { value: before };
          // Creating the first Atlas mapping would otherwise enable its schedule implicitly.
          if (!record(effective.atlas)) changes.enable = proposed.enable;
          const next = { ...before.settings, ...changes };
          const policies = parsePolicy({ auto_update: { ...next, enable: true } });
          for (const [key, rule] of [["check_cron", policies.version], ["challenge_cron", policies.challenge]] as const) {
            if ((changes[key] !== undefined || changes.enable === true) && (!rule.cron || !validModuleCron(rule.cron))) {
              throw new InvalidAtlasCron(key);
            }
          }
          const { yaml, atlas } = writeSettings(text, local, effective, changes, args, searchLimit);
          return { yaml, value: snapshot({ atlas }, parsePolicy, search) };
        },
      }));
    } catch (error) {
      if (error instanceof InvalidAtlasCron) return Response.json({ field: error.field }, { status: 400 });
      if (error instanceof UnsupportedAtlasScope) return Response.json({ field: error.field }, { status: 422 });
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
