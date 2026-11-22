import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Document, isAlias, isMap, isNode, isSeq, parseDocument, type Node } from "yaml";
import { readOptionalLocalConfig } from "./config.ts";
import { globalPermissionLists, globalPermissionPolicies, isPermissionId, sortPermissionIds,
  type GlobalPermissionList, type GlobalPermissionSettings, type GlobalPermissionSnapshot } from "./global-permission-policy.ts";
import { inheritLotusGlobalConfig, normalizeLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair,
  type Pair, type SourceEdit } from "./yaml-source-edits.ts";

type Config = Readonly<Record<string, unknown>>;
type Changes = Partial<GlobalPermissionSettings>;
type Tree = { [name: string]: Tree | readonly unknown[] | string };
const revisionKey = randomBytes(32);

function record(input: unknown): Config | undefined {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) return input as Config;
}

function entries(input: unknown): readonly unknown[] {
  return input === undefined || input === null ? [] : Array.isArray(input) ? input : [input];
}

function id(input: unknown) {
  const text = typeof input === "number" ? String(input) : input;
  return isPermissionId(text) ? text : undefined;
}

function values(config: Config, field: GlobalPermissionList) {
  const [scope, type] = field.split(".") as ["users" | "groups", "allow" | "deny"];
  return entries(record(record(config.permissions)?.[scope])?.[type]);
}

function localPermissionAliases(local: Config) {
  // An explicit list overrides values from another file. The reader still adds aliases from this file.
  return normalizeLotusGlobalConfig({ ...local, permissions: undefined });
}

function snapshot(local: Config, effective: Config): GlobalPermissionSnapshot {
  const permissions = record(effective.permissions);
  const aliases = localPermissionAliases(local);
  const settings = {
    default_policy: permissions?.default_policy === "deny" ? "deny" : "allow",
    ...Object.fromEntries(globalPermissionLists.map(field =>
      [field, sortPermissionIds(values(effective, field).map(id).filter(isPermissionId))])),
  } as GlobalPermissionSettings;
  const locked: GlobalPermissionSnapshot["locked"] = Object.fromEntries(globalPermissionLists.flatMap(field => {
    const keep = sortPermissionIds(values(aliases, field).map(id).filter(isPermissionId));
    return keep.length ? [[field, keep]] : [];
  }));
  const retained = Object.fromEntries(globalPermissionLists.flatMap(field => {
    const count = values(effective, field).filter(entry => id(entry) === undefined).length;
    return count ? [[field, count]] : [];
  }));
  const revision = createHmac("sha256", revisionKey)
    .update(JSON.stringify([permissions, local.permissions, aliases.permissions])).digest("hex");
  return { revision, settings, locked, retained };
}

function parseChanges(input: unknown): Changes {
  const fields = record(input);
  if (!fields || !Object.keys(fields).length) throw new Error();
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (key === "default_policy") {
      if (!globalPermissionPolicies.some(policy => policy === value)) throw new Error();
      return [key, value];
    }
    if (!globalPermissionLists.some(field => field === key) || !Array.isArray(value) || !value.every(isPermissionId)) throw new Error();
    return [key, sortPermissionIds(value)];
  }));
}

function replacementList(local: Config, effective: Config, field: GlobalPermissionList, next: readonly string[]) {
  const explicit = new Map(values(local, field).map(value => [String(value), value] as const));
  const implicit = new Set(values(localPermissionAliases(local), field).map(String));
  const pending = new Set(next);
  const kept = values(effective, field).flatMap(entry => {
    const key = id(entry);
    if (key !== undefined && !pending.delete(key)) return [];
    const source = String(entry);
    if (explicit.has(source)) return [explicit.get(source)];
    return implicit.has(source) ? [] : [entry];
  });
  return [...kept, ...pending];
}

function merge(current: unknown, tree: Tree): Config {
  const prior = record(current);
  if (!prior && current !== undefined) throw new GlobalConfigWriteError("config");
  return { ...prior, ...Object.fromEntries(Object.entries(tree).map(([name, value]) =>
    [name, typeof value === "string" || Array.isArray(value) ? value : merge(prior?.[name], value as Tree)])) };
}

function replaceList(text: string, node: Node, before: unknown, next: readonly unknown[]): SourceEdit {
  if (!isSeq(node)) return replaceSourceScalar(text, node, JSON.stringify(next));
  if (!node.range) throw new GlobalConfigWriteError("config");

  const document = new Document();
  const sequence = node.clone();
  const available = entries(before).map((value, index) => ({ value, item: sequence.items[index], selected: false }));
  sequence.items = next.map(value => {
    const match = available.find(candidate => !candidate.selected && isDeepStrictEqual(candidate.value, value));
    if (!match) return document.createNode(value);
    match.selected = true;
    return match.item;
  });
  document.set("list", sequence);
  const printed = document.toString({ lineWidth: 0 });
  const item = parseDocument(printed).get("list", true);
  if (!isSeq(item) || !item.range) throw new GlobalConfigWriteError("config");

  const [start, end] = node.range;
  const [printedStart, printedEnd] = item.range;
  const oldIndent = start - text.lastIndexOf("\n", start - 1) - 1;
  const newIndent = printedStart - printed.lastIndexOf("\n", printedStart - 1) - 1;
  const eol = /\r?\n/u.exec(text)?.[0] ?? "\n";
  let value = printed.slice(printedStart, printedEnd).split("\n").map((line, index) =>
    index === 0 || !line ? line : " ".repeat(oldIndent) + line.slice(newIndent)).join(eol);
  if (text.slice(start, end).endsWith("\n") && !value.endsWith("\n")) value += eol;
  return { start, end, value };
}

function editPermissions(text: string, current: Config, tree: Tree) {
  const yaml = parseDocument(text, { merge: true, strict: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const edits: SourceEdit[] = [];

  function editMap(node: Node | undefined, prior: Config, branch: Tree) {
    if (node !== undefined && !isMap(node) && !isAlias(node)) throw new GlobalConfigWriteError("config");
    const additions: Pair[] = [];
    for (const [key, value] of Object.entries(branch)) {
      const existing = isMap(node) ? node.get(key, true) : undefined;
      if (typeof value === "string" || Array.isArray(value)) {
        const flow = JSON.stringify(value);
        if (isNode(existing)) edits.push(typeof value === "string" ? replaceSourceScalar(text, existing, flow) :
          replaceList(text, existing, prior[key], value));
        else additions.push({ key, flow, block: [`${key}: ${flow}`] });
      } else if (isNode(existing)) {
        editMap(existing, record(prior[key]) ?? {}, value as Tree);
      } else {
        additions.push(sourceMappingPair(key, merge(prior[key], value as Tree)));
      }
    }
    if (additions.length) edits.push(isAlias(node) ? sourceAliasOverrides(text, node, additions)
      : insertSourcePairs(text, node, additions));
  }

  const expected = merge(current, tree);
  editMap(yaml.contents ?? undefined, current, tree);
  const result = edits.sort((left, right) => right.start - left.start || right.end - left.end)
    .reduce((value, edit) => value.slice(0, edit.start) + edit.value + value.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), expected)) throw new GlobalConfigWriteError("config");
  return result;
}

class LegacyPermissionAlias extends Error {}

export function panelGlobalPermissions(root: URL) {
  async function read() {
    const local = await readOptionalLocalConfig(root, "global") ?? {};
    return snapshot(local, await inheritLotusGlobalConfig(root, local));
  }
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method === "GET") {
      try {
        const current = await read();
        return active() ? Response.json(current) : new Response(null, { status: 401 });
      } catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    let revision: string;
    let patch: Changes;
    try {
      const payload = record(await readPanelJson(request, 65_536));
      if (!payload || Object.keys(payload).length !== 2 || typeof payload.revision !== "string" ||
          !/^[a-f0-9]{64}$/u.test(payload.revision)) throw new Error();
      revision = payload.revision;
      patch = parseChanges(payload.patch);
    } catch { return new Response(null, { status: 400 }); }

    try {
      await updateLotusGlobalConfig(root, {
        signal: request.signal, canWrite: active, canCommit: active,
        prepare(text, local, effective) {
          const before = snapshot(local, effective);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const permissions: Tree = {};
          if (patch.default_policy !== undefined && before.settings.default_policy !== patch.default_policy) {
            permissions.default_policy = patch.default_policy;
          }
          for (const field of globalPermissionLists) {
            const next = patch[field];
            if (next === undefined || isDeepStrictEqual(next, before.settings[field])) continue;
            if (before.locked[field]?.some(legacyId => !next.includes(legacyId))) throw new LegacyPermissionAlias();
            const [scope, type] = field.split(".") as ["users" | "groups", "allow" | "deny"];
            const branch = (permissions[scope] ??= {}) as Tree;
            branch[type] = replacementList(local, effective, field, next);
          }
          const yaml = Object.keys(permissions).length ? editPermissions(text, local, { permissions }) : undefined;
          return { yaml, value: undefined };
        },
      });
      const updated = await read();
      return active() ? Response.json(updated) : new Response(null, { status: 401 });
    } catch (error) {
      if (error instanceof LegacyPermissionAlias) return Response.json({ reason: "legacy_alias" }, { status: 422 });
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
