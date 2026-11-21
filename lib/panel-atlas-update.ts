import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument, type Node } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair } from "./yaml-source-edits.ts";

const defaults = { check_cron: "0 0 */6 * * ? *", challenge_cron: "0 15 */2 * * ? *" };
type Settings = typeof defaults & { enable: boolean };
type Config = Readonly<Record<string, unknown>>;

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function snapshot(document: Config) {
  const atlas = record(document.atlas);
  const auto = record(atlas?.auto_update);
  const settings: Settings = {
    enable: atlas !== undefined && (atlas.auto_update === undefined || auto !== undefined) &&
      (auto?.enable === undefined || auto.enable === true),
    check_cron: typeof auto?.check_cron === "string" ? auto.check_cron : defaults.check_cron,
    challenge_cron: typeof auto?.challenge_cron === "string" ? auto.challenge_cron : defaults.challenge_cron,
  };
  const revision = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
  return { settings, revision };
}

function writeSettings(text: string, local: Config, effective: Config, changes: Partial<Settings>) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const prior = record(effective.atlas) ?? {};
  const auto = record(prior.auto_update) ?? {};
  if ((effective.atlas !== undefined && !record(effective.atlas)) ||
      (prior.auto_update !== undefined && !record(prior.auto_update))) throw new GlobalConfigWriteError("config");
  // Atlas fields are inherited as a group. Preserve the effective old fields when first creating a local section.
  const atlas = { ...prior, auto_update: { ...auto, ...changes } };
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
  } else if (!isNode(autoNode)) {
    edits.push(insert(atlasNode, [sourceMappingPair("auto_update", atlas.auto_update)]));
  } else {
    const additions: Pair[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const source = isMap(autoNode) ? autoNode.get(key, true) : undefined;
      const flow = JSON.stringify(value);
      if (isNode(source)) edits.push(replaceSourceScalar(text, source, flow));
      else additions.push({ key, flow, block: [`${key}: ${flow}`] });
    }
    if (additions.length) edits.push(insert(autoNode, additions));
  }
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), { ...local, atlas })) throw new GlobalConfigWriteError("config");
  return result;
}

export function panelAtlasUpdate(root: URL, validModuleCron: (cron: string) => boolean) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(snapshot(await readLotusGlobalConfig(root))); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    let revision: string;
    let proposed: Settings;
    try {
      const body = record(await readPanelJson(request, 4096));
      const settings = record(body?.settings);
      if (!body || Object.keys(body).length !== 2 || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/u.test(body.revision) ||
          !settings || Object.keys(settings).length !== 3 || typeof settings.enable !== "boolean" ||
          typeof settings.check_cron !== "string" || settings.check_cron.length > 160 ||
          typeof settings.challenge_cron !== "string" || settings.challenge_cron.length > 160) throw new Error();
      revision = body.revision;
      proposed = { enable: settings.enable, check_cron: settings.check_cron.trim() || defaults.check_cron,
        challenge_cron: settings.challenge_cron.trim() || defaults.challenge_cron };
    } catch { return new Response(null, { status: 400 }); }

    let policies: ReturnType<typeof import("../plugins/atlas/update-policy.ts").parseAtlasUpdatePolicy>;
    try {
      // The builtin may be absent before bootstrap. Load its parser only when editing its configuration.
      const { parseAtlasUpdatePolicy } = await import("../plugins/atlas/update-policy.ts");
      policies = parseAtlasUpdatePolicy({ auto_update: { ...proposed, enable: true } });
    } catch { return new Response(null, { status: 503 }); }
    for (const [key, rule] of [["check_cron", policies.version], ["challenge_cron", policies.challenge]] as const) {
      if (!rule.cron || !validModuleCron(rule.cron)) return Response.json({ field: key }, { status: 400 });
    }

    const active = () => !request.signal.aborted && stillAuthorized();
    try {
      return Response.json(await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const before = snapshot(effective);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const changes: Partial<Settings> = {};
          if (before.settings.enable !== proposed.enable || (!record(effective.atlas) &&
              (before.settings.check_cron !== proposed.check_cron || before.settings.challenge_cron !== proposed.challenge_cron))) {
            changes.enable = proposed.enable;
          }
          if (before.settings.check_cron !== proposed.check_cron) changes.check_cron = proposed.check_cron;
          if (before.settings.challenge_cron !== proposed.challenge_cron) changes.challenge_cron = proposed.challenge_cron;
          if (!Object.keys(changes).length) return { value: before };
          const yaml = writeSettings(text, local, effective, changes);
          return { yaml, value: snapshot({ atlas: { auto_update: proposed } }) };
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
