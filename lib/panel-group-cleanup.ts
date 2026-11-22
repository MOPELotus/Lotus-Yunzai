import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument, type Node } from "yaml";
import { groupCleanupConfig } from "./group-cleanup-config.ts";
import { accountScopePolicies, accountScopePolicy, type AccountScopePolicy } from "./account-scope-policy.ts";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { editAccountScopePolicies } from "./panel-account-permissions.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "./yaml-source-edits.ts";

const fields = ["dry_run", "remove_group_fallback"] as const;
const scope = "group.cleanup";
const revisionKey = randomBytes(32);
type Patch = Partial<Record<typeof fields[number], boolean>>;
type Config = Readonly<Record<string, unknown>>;

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function snapshot(effective: Config, patch: Patch = {}, policy?: AccountScopePolicy) {
  const { dryRun, removeFallback, archiveRequested } = groupCleanupConfig(effective.groups);
  const permissions = record(effective.permissions);
  const configured = policy ?? record(record(permissions?.scopes)?.[scope])?.policy;
  const settings = { dry_run: patch.dry_run ?? dryRun, remove_group_fallback: patch.remove_group_fallback ?? removeFallback };
  const scopePolicy = accountScopePolicy(scope, configured);
  const revision = createHmac("sha256", revisionKey).update(JSON.stringify([settings, archiveRequested,
    scopePolicy, configured, permissions?.default_policy, permissions?.users, permissions?.groups])).digest("hex");
  return { settings, archiveRequested, scopePolicy, revision };
}

function editCleanup(text: string, local: Config, patch: Patch) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const groups = record(local.groups);
  const cleanup = record(groups?.cleanup);
  if ((!groups && Object.hasOwn(local, "groups")) || (groups && !cleanup && Object.hasOwn(groups, "cleanup"))) {
    throw new GlobalConfigWriteError("config");
  }
  // The global reader already overlays individual cleanup fields, so write only local values.
  const nextGroups = { ...groups, cleanup: { ...cleanup, ...patch } };
  const root = yaml.contents ?? undefined;
  const groupsNode = isMap(root) ? root.get("groups", true) : undefined;
  const cleanupNode = isMap(groupsNode) ? groupsNode.get("cleanup", true) : undefined;
  const edits: SourceEdit[] = [];
  function insert(node: Node | undefined, pairs: Pair[]) {
    if (!pairs.length) return;
    if (isAlias(node)) edits.push(sourceAliasOverrides(text, node, pairs));
    else if (!node || isMap(node)) edits.push(insertSourcePairs(text, node, pairs));
    else throw new GlobalConfigWriteError("config");
  }
  if (!isNode(groupsNode)) insert(root, [sourceMappingPair("groups", nextGroups)]);
  else if (!isNode(cleanupNode)) insert(groupsNode, [sourceMappingPair("cleanup", nextGroups.cleanup)]);
  else {
    const additions: Pair[] = [];
    for (const [name, value] of Object.entries(patch)) {
      const old = isMap(cleanupNode) ? cleanupNode.get(name, true) : undefined;
      const flow = String(value);
      if (isNode(old)) edits.push(replaceSourceScalar(text, old, flow));
      else additions.push({ key: name, flow, block: [`${name}: ${flow}`] });
    }
    insert(cleanupNode, additions);
  }
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((current, edit) => current.slice(0, edit.start) + edit.value + current.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), { ...local, groups: nextGroups })) throw new GlobalConfigWriteError("config");
  return result;
}

export function panelGroupCleanup(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(snapshot(await readLotusGlobalConfig(root))); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    let revision: string;
    const patch: Patch = {};
    let policy: AccountScopePolicy | undefined;
    try {
      const body = record(await readPanelJson(request, 4096));
      const values = record(body?.patch);
      if (!body || Object.keys(body).length !== 2 || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/u.test(body.revision) ||
          !values || !Object.keys(values).length) throw new Error();
      revision = body.revision;
      for (const [key, value] of Object.entries(values)) {
        if (key === "scope_policy") {
          policy = accountScopePolicies.find(item => item === value);
          if (!policy) throw new Error();
          continue;
        }
        const field = fields.find(name => name === key);
        if (!field || typeof value !== "boolean") throw new Error();
        patch[field] = value;
      }
    } catch { return new Response(null, { status: 400 }); }

    const active = () => !request.signal.aborted && stillAuthorized();
    try {
      return Response.json(await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const before = snapshot(effective);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const changes = Object.fromEntries(fields.flatMap(key => patch[key] === undefined || patch[key] === before.settings[key]
            ? [] : [[key, patch[key]]]));
          const newPolicy = policy === before.scopePolicy ? undefined : policy;
          const editOptions = Object.keys(changes).length > 0;
          if (!editOptions && !newPolicy) return { value: before };
          let yaml = editOptions ? editCleanup(text, local, changes) : text;
          if (newPolicy) {
            yaml = editAccountScopePolicies(yaml, editOptions ? Bun.YAML.parse(yaml) as Config : local, { [scope]: newPolicy });
          }
          return { yaml, value: snapshot(effective, changes, newPolicy) };
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
