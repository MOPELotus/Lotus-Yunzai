import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, parseDocument, type Document } from "yaml";
import { groupRoutingScopePattern, readGroupRoutingConfig } from "./group-dispatch.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

const fields = [
  { key: "file", label: $t("lib.panel-group-routing.text_1d27f02ed2"), type: "text", readonly: true },
  { key: "rules", label: $t("lib.panel-group-routing.text_4ce0524c1b"), type: "json", rows: 12,
    hint: $t("lib.panel-group-routing.text_c2d0801dfe") },
] as const;
const known = ["groupCD", "singleCD", "onlyReplyAt", "botAlias", "addLimit", "addPrivate", "addReply", "addAt",
  "addRecall", "enable", "disable"] as const;
type RuleKey = typeof known[number];
type RuleValue = null | boolean | number | string | string[];
type Rules = Record<string, Partial<Record<RuleKey, RuleValue>> | null>;
const primary = "config/group.yaml";
const legacy = "config/config/group.yaml";
const maxConfigBytes = 524_288;

function record(input: unknown): Record<string, unknown> | undefined {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
}

function validScope(scope: string) {
  return groupRoutingScopePattern.test(scope) &&
    scope.split(":").every(part => part === "default" || Number.isSafeInteger(Number(part)));
}

function validValue(key: RuleKey, value: unknown): value is RuleValue {
  if (value === null) return true;
  if (key === "botAlias" || key === "enable" || key === "disable") {
    const validText = (text: unknown) => typeof text === "string" && text.length <= 256 && !text.includes("\0");
    return validText(value) || (Array.isArray(value) && value.length <= 256 && value.every(validText));
  }
  const number = typeof value === "string" && /^\d{1,10}$/u.test(value.trim()) ? Number(value) : value;
  const toggle = key === "addPrivate" || key === "addReply" || key === "addAt";
  if (toggle && typeof number === "boolean") return true;
  const max = toggle ? 1 : key === "onlyReplyAt" || key === "addLimit" ? 2 : 2_147_483_647;
  return typeof number === "number" && Number.isInteger(number) && number >= 0 && number <= max;
}

function exposedRules(config: Record<string, unknown>): Rules {
  const result: Rules = {};
  for (const [scope, raw] of Object.entries(config)) {
    if (!validScope(scope)) continue;
    const rule = record(raw);
    if (raw === null) result[scope] = null;
    if (rule) {
      const visible = Object.fromEntries(known.filter(key => Object.hasOwn(rule, key) &&
        validValue(key, rule[key])).map(key => [key, rule[key]]));
      result[scope] = visible;
    }
  }
  return result;
}

function validSnapshot(value: unknown): value is { file: typeof primary | typeof legacy; rules: Rules } {
  const input = record(value);
  if (!input || Object.keys(input).length !== 2 || (input.file !== primary && input.file !== legacy)) return false;
  const rules = record(input.rules);
  return !!rules && Object.entries(rules).every(([scope, raw]) => {
    if (!validScope(scope)) return false;
    if (raw === null) return true;
    const rule = record(raw);
    return !!rule && Object.entries(rule).every(([key, value]) =>
      known.includes(key as RuleKey) && validValue(key as RuleKey, value));
  });
}

function updateYaml(content: string, local: Record<string, unknown>, before: Rules, next: Rules, file: string) {
  const doc: Document = parseDocument(content);
  if (doc.errors.length) throw new GlobalConfigWriteError("config");
  if (!doc.contents || (isScalar(doc.contents) && doc.contents.value === null)) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new GlobalConfigWriteError("config");
  const map = doc.contents;
  const expected = structuredClone(local);
  for (const scope of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (isDeepStrictEqual(before[scope], next[scope])) continue;
    const hasExisting = Object.hasOwn(expected, scope);
    const existing = record(expected[scope]);
    if (hasExisting && expected[scope] !== null && !existing) throw new GlobalConfigWriteError("config");
    const existingKey = map.items.find(item => isScalar(item.key) && String(item.key.value) === scope)?.key;
    const key = isScalar(existingKey) ? existingKey.value : scope;
    const requested = next[scope];
    const merged: Record<string, unknown> = { ...existing, ...requested };
    const removed = Object.keys(before[scope] ?? {}).filter(field => !Object.hasOwn(requested ?? {}, field));
    for (const field of removed) delete merged[field];

    if (!Object.keys(merged).length && requested === undefined) {
      doc.delete(key);
      delete expected[scope];
    } else if (!Object.keys(merged).length && requested === null) {
      doc.set(key, null);
      expected[scope] = null;
    } else {
      if (isMap(doc.get(key, true))) {
        for (const field of removed) doc.deleteIn([key, field]);
        for (const [field, value] of Object.entries(requested ?? {})) {
          if (!isDeepStrictEqual(value, existing?.[field])) doc.setIn([key, field], value);
        }
      } else {
        doc.set(key, doc.createNode(merged));
      }
      expected[scope] = merged;
    }
  }
  // Keep the active modern file selected when clearing its last override.
  if (file === primary && Object.keys(local).some(scope => groupRoutingScopePattern.test(scope)) &&
    !Object.keys(expected).some(scope => groupRoutingScopePattern.test(scope))) {
    doc.set("default", doc.createNode({}));
    expected.default = {};
  }
  const yaml = doc.toString();
  if (Buffer.byteLength(yaml) > maxConfigBytes || !isDeepStrictEqual(Bun.YAML.parse(yaml), expected)) {
    throw new GlobalConfigWriteError("config");
  }
  return yaml;
}

export function panelGroupRouting(root: URL, onSaved: () => Promise<void>) {
  async function snapshot() {
    const current = await readGroupRoutingConfig(root, maxConfigBytes);
    return { file: current?.path ?? primary, rules: exposedRules(current?.overrides ?? {}) };
  }

  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method === "GET") {
      try {
        const values = await snapshot();
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      } catch {
        return new Response(null, { status: 500 });
      }
    }

    let input: Record<string, unknown> | undefined;
    try { input = record(await readPanelJson(request, 1_048_576)); }
    catch { return new Response(null, { status: 400 }); }
    if (!input || Object.keys(input).length !== 2 || !validSnapshot(input.previous) ||
      !validSnapshot(input.values) || input.previous.file !== input.values.file) return new Response(null, { status: 400 });

    const { previous, values } = input;
    try {
      await updateLocalConfiguration(root, "group", {
        override: fileURLToPath(new URL(previous.file, root)),
        canWrite: active, canCommit: active, signal: request.signal, resolveEffective: snapshot,
        prepare(content, local, effective) {
          if (!isDeepStrictEqual(previous, effective)) throw new GlobalConfigWriteError("conflict");
          if (isDeepStrictEqual(previous.rules, values.rules)) return { value: undefined };
          return { yaml: updateYaml(content, local, previous.rules, values.rules, previous.file), value: undefined };
        },
      });
      let warning: string | undefined;
      try { await onSaved(); }
      catch { warning = $t("lib.panel-group-routing.text_970af71c40"); }
      return Response.json({ fields, values: await snapshot(), warning });
    } catch (error) {
      if (!active()) return new Response(null, { status: 401 });
      if (error instanceof GlobalConfigWriteError && error.reason === "config") {
        return Response.json({ message: $t("lib.panel-group-routing.text_42434a44ea") }, { status: 400 });
      }
      return Response.json({ message: $t("lib.panel-group-routing.text_b3389dad0c") }, { status: 409 });
    }
  };
}
