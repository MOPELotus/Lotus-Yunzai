import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument, type Node } from "yaml";
import { accountScopePolicies, accountScopePolicy, accountScopes, mediaDownloadScopes, mediaOwnerScopePolicies, mediaOwnerScopes,
  type AccountScopePolicy, type ScopePolicySnapshot } from "./account-scope-policy.ts";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair,
  type Pair, type SourceEdit } from "./yaml-source-edits.ts";

type Config = Readonly<Record<string, unknown>>;
type Changes<Scope extends string> = Partial<Record<Scope, AccountScopePolicy>>;
type ReadPolicy<Scope> = (scope: Scope, configured: unknown, hasScope: boolean) => AccountScopePolicy;
type Policies<Scope> = (scope: Scope) => readonly AccountScopePolicy[];
interface PolicyTree { [name: string]: AccountScopePolicy | PolicyTree }
const revisionKey = randomBytes(32);

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function snapshot<Scope extends string>(document: Config, allowed: readonly Scope[],
  readPolicy: ReadPolicy<Scope>, includeRaw: boolean, patch: Changes<Scope> = {}): ScopePolicySnapshot<Scope> {
  const permissions = record(document.permissions) ?? {};
  const scopes = record(permissions.scopes) ?? {};
  const settings = Object.fromEntries(allowed.map(scope =>
    [scope, patch[scope] ?? readPolicy(scope, record(scopes[scope])?.policy, Object.hasOwn(scopes, scope))],
  )) as ScopePolicySnapshot<Scope>["settings"];
  const raw = includeRaw ? allowed.map(scope => ({
    present: patch[scope] !== undefined || Object.hasOwn(scopes, scope),
    value: patch[scope] ?? record(scopes[scope])?.policy,
  })) : undefined;
  const revision = createHmac("sha256", revisionKey)
    .update(JSON.stringify([settings, permissions.default_policy, permissions.users, permissions.groups, raw])).digest("hex");
  return { revision, settings };
}

function parseChanges<Scope extends string>(input: unknown, allowed: readonly Scope[],
  policies: Policies<Scope> = () => accountScopePolicies): Changes<Scope> {
  const fields = record(input);
  if (!fields || !Object.keys(fields).length) throw new Error();
  const changes: Changes<Scope> = {};
  for (const [key, value] of Object.entries(fields)) {
    const scope = allowed.find(entry => entry === key);
    if (!scope) throw new Error();
    const policy = policies(scope).find(entry => entry === value);
    if (!policy) throw new Error();
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

export function editAccountScopePolicies(text: string, current: Config, changes: Changes<string>) {
  const yaml = parseDocument(text, { merge: true, strict: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const tree: PolicyTree = { permissions: { scopes: Object.fromEntries(Object.entries(changes)
    .flatMap(([scope, policy]) => policy === undefined ? [] : [[scope, { policy }]])) } };
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

function panelScopePermissions<Scope extends string>(root: URL, allowed: readonly Scope[],
  readPolicy: ReadPolicy<Scope>, ownerPolicies?: Policies<Scope>) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(snapshot(await readLotusGlobalConfig(root), allowed, readPolicy, ownerPolicies !== undefined)); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });

    let revision: string;
    let patch: Changes<Scope>;
    try {
      const data = record(await readPanelJson(request, 4096));
      if (!data || Object.keys(data).length !== 2 || typeof data.revision !== "string" || !/^[a-f0-9]{64}$/u.test(data.revision)) {
        throw new Error();
      }
      revision = data.revision;
      patch = parseChanges(data.patch, allowed, ownerPolicies);
    } catch {
      return new Response(null, { status: 400 });
    }

    const active = () => !request.signal.aborted && stillAuthorized();
    try {
      return Response.json(await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const before = snapshot(effective, allowed, readPolicy, ownerPolicies !== undefined);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const changes = Object.fromEntries(allowed.flatMap(scope =>
            patch[scope] === undefined || patch[scope] === before.settings[scope] ? [] : [[scope, patch[scope]]],
          )) as Changes<Scope>;
          if (!Object.keys(changes).length) return { value: before };
          return { yaml: editAccountScopePolicies(text, local, changes),
            value: snapshot(effective, allowed, readPolicy, ownerPolicies !== undefined, changes) };
        },
      }));
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}

export function panelAccountPermissions(root: URL) {
  return panelScopePermissions(root, accountScopes, accountScopePolicy);
}

export function panelMediaDownloadPermissions(root: URL) {
  // The media reader coerces legacy YAML policy values before applying its inherit fallback.
  return panelScopePermissions(root, mediaDownloadScopes, (_scope, configured) =>
    accountScopePolicies.find(policy => policy === String(configured || "inherit")) ?? "inherit");
}

export function panelMediaOwnerPermissions(root: URL) {
  return panelScopePermissions(root, mediaOwnerScopes, (scope, configured, hasScope) => {
    if (scope !== "netease.partner") return configured === "deny" ? "deny" : "master_only";
    if (!hasScope) return "master_only";
    return accountScopePolicies.find(policy => policy === String(configured || "inherit")) ?? "inherit";
  }, mediaOwnerScopePolicies);
}
