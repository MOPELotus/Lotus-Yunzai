import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument, type Node } from "yaml";
import { accountScopePolicies, accountScopePolicy, accountScopes,
  type AccountScope, type AccountScopePolicy, type AccountScopeSnapshot } from "./account-scope-policy.ts";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair,
  type Pair, type SourceEdit } from "./yaml-source-edits.ts";

type Config = Readonly<Record<string, unknown>>;
type Changes = Partial<Record<AccountScope, AccountScopePolicy>>;
interface PolicyTree { [name: string]: AccountScopePolicy | PolicyTree }
const revisionKey = randomBytes(32);

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function snapshot(document: Config, patch: Changes = {}): AccountScopeSnapshot {
  const permissions = record(document.permissions) ?? {};
  const scopes = record(permissions.scopes) ?? {};
  const settings = Object.fromEntries(accountScopes.map(scope =>
    [scope, patch[scope] ?? accountScopePolicy(scope, record(scopes[scope])?.policy)],
  )) as AccountScopeSnapshot["settings"];
  const revision = createHmac("sha256", revisionKey)
    .update(JSON.stringify([settings, permissions.default_policy, permissions.users, permissions.groups])).digest("hex");
  return { revision, settings };
}

function parseChanges(input: unknown): Changes {
  const fields = record(input);
  if (!fields || !Object.keys(fields).length) throw new Error();
  const changes: Changes = {};
  for (const [key, value] of Object.entries(fields)) {
    const scope = accountScopes.find(entry => entry === key);
    const policy = accountScopePolicies.find(entry => entry === value);
    if (!scope || !policy) throw new Error();
    changes[scope] = policy;
  }
  return changes;
}

function merge(current: unknown, tree: PolicyTree): Config {
  const prior = record(current);
  if (!prior && current !== undefined) throw new GlobalConfigWriteError("config");
  return {
    ...prior,
    ...Object.fromEntries(Object.entries(tree).map(([key, value]) =>
      [key, typeof value === "string" ? value : merge(prior?.[key], value)])),
  };
}

function editPolicies(text: string, current: Config, changes: Changes) {
  const yaml = parseDocument(text, { merge: true, strict: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const tree: PolicyTree = { permissions: { scopes: Object.fromEntries(Object.entries(changes)
    .map(([scope, policy]) => [scope, { policy }])) } };
  const edits: SourceEdit[] = [];

  function editMap(node: Node | undefined, prior: Config, branch: PolicyTree) {
    if (node !== undefined && !isMap(node) && !isAlias(node)) throw new GlobalConfigWriteError("config");
    const additions: Pair[] = [];
    for (const [key, value] of Object.entries(branch)) {
      const existing = isMap(node) ? node.get(key, true) : undefined;
      if (typeof value === "string") {
        const flow = JSON.stringify(value);
        if (isNode(existing)) edits.push(replaceSourceScalar(text, existing, flow));
        else additions.push({ key, flow, block: [`${key}: ${flow}`] });
      } else if (isNode(existing)) {
        editMap(existing, record(prior[key]) ?? {}, value);
      } else {
        additions.push(sourceMappingPair(key, merge(prior[key], value)));
      }
    }
    if (additions.length) edits.push(isAlias(node) ? sourceAliasOverrides(text, node, additions)
      : insertSourcePairs(text, node, additions));
  }

  const expected = merge(current, tree);
  editMap(yaml.contents ?? undefined, current, tree);
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), expected)) throw new GlobalConfigWriteError("config");
  return result;
}

export function panelAccountPermissions(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(snapshot(await readLotusGlobalConfig(root))); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });

    let revision: string;
    let patch: Changes;
    try {
      const data = record(await readPanelJson(request, 4096));
      if (!data || Object.keys(data).length !== 2 || typeof data.revision !== "string" || !/^[a-f0-9]{64}$/u.test(data.revision)) {
        throw new Error();
      }
      revision = data.revision;
      patch = parseChanges(data.patch);
    } catch {
      return new Response(null, { status: 400 });
    }

    const active = () => !request.signal.aborted && stillAuthorized();
    try {
      return Response.json(await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const before = snapshot(effective);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const changes = Object.fromEntries(accountScopes.flatMap(scope =>
            patch[scope] === undefined || patch[scope] === before.settings[scope] ? [] : [[scope, patch[scope]]],
          )) as Changes;
          if (!Object.keys(changes).length) return { value: before };
          return { yaml: editPolicies(text, local, changes), value: snapshot(effective, changes) };
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
