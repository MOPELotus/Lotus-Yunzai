import { isAlias, isSeq, type Node } from "yaml";
import { atlasScopeFields, type AtlasScopeField, type AtlasScopeSelections, type AtlasScopePatch } from "./panel-atlas-scope-schema.ts";
import { replaceSourceScalar, type SourceEdit } from "./yaml-source-edits.ts";

type Parser = typeof import("../plugins/atlas/update-policy.ts").parseAtlasUpdatePolicy;
type Atlas = Readonly<Record<string, unknown>>;
const fields = ["update_args", "challenge_args"] as const satisfies readonly AtlasScopeField[];
const supportedLocale = /^(?:all|zh|cn|zh-cn|zh-hans|zh_hans)$/iu;

export class UnsupportedAtlasScope extends Error {
  constructor(readonly field: AtlasScopeField) { super(); }
}

function parts(value: string, delimiter = ",") {
  return value.split(delimiter).map(part => part.trim()).filter(Boolean);
}

// The runtime accepts intersections and may ignore unknown game/page IDs. Only replace a
// legacy expression when each individual qualifier is representable in this editor.
function representable(raw: unknown, available: readonly string[]) {
  if (raw === undefined) return true;
  if (!Array.isArray(raw) || !raw.every((token): token is string => typeof token === "string")) return false;
  const args = (raw[0] === "src/scrape.mjs" ? raw.slice(1) : raw).values();
  for (const token of args) {
    if (token === "--incremental") continue;
    const match = /^--(game|locales?|pages?|mode)(?:=(.*))?$/u.exec(token);
    if (!match) return false;
    const [, flag, inline] = match;
    const value = inline ?? args.next().value;
    if (!value) return false;
    if (flag === "mode" && value !== "incremental") return false;
    if (flag === "game" && !parts(value).every(game => available.some(page => page.startsWith(game + "/")))) return false;
    if ((flag === "locale" || flag === "locales") && !parts(value).every(locale => supportedLocale.test(locale))) return false;
    if (flag === "page" || flag === "pages") {
      for (const page of parts(value, ";")) {
        const label = /^([a-z0-9_-]+)\s*[=:]\s*(.+)$/u.exec(page);
        if (!label || !parts(label[2]!).every(item => available.includes(label[1] + "/" + item))) return false;
      }
    }
  }
  return true;
}

export function atlasScopeSnapshot(atlas: Atlas | undefined, parsePolicy: Parser): AtlasScopeSelections {
  const supported = parsePolicy({});
  return Object.fromEntries(fields.map(field => {
    const kind = atlasScopeFields[field];
    const available = supported[kind].selections;
    const raw = atlas?.[field];
    const policy = parsePolicy({ [field]: raw, auto_update: { enable: false } })[kind];
    const selected = !policy.issue && policy.selections.length && representable(raw, available) ? policy.selections : null;
    return [field, { available, selected }];
  })) as AtlasScopeSelections;
}

export function parseAtlasScopePatch(raw: unknown): AtlasScopePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) throw new Error();
  const patch: AtlasScopePatch = {};
  for (const [field, value] of Object.entries(raw)) {
    const key = fields.find(item => item === field);
    if (!key || !Array.isArray(value) || value.length < 1 || value.length > 100 ||
        value.some(item => typeof item !== "string") || new Set(value).size !== value.length) throw new Error();
    patch[key] = value;
  }
  return patch;
}

export function atlasScopeChanges(patch: AtlasScopePatch, before: AtlasScopeSelections, parsePolicy: Parser): AtlasScopePatch {
  const changes: AtlasScopePatch = {};
  for (const field of fields) {
    const proposed = patch[field];
    if (!proposed) continue;
    const { selected, available } = before[field];
    if (!selected || proposed.some(item => !available.includes(item))) throw new UnsupportedAtlasScope(field);
    const target = available.filter(item => proposed.includes(item));
    if (target.length === selected.length && target.every((item, index) => item === selected[index])) continue;
    const games = new Map<string, string[]>();
    for (const item of target) {
      const separator = item.indexOf("/");
      const game = item.slice(0, separator);
      const entries = games.get(game) ?? [];
      entries.push(item.slice(separator + 1));
      games.set(game, entries);
    }
    const args = target.length === available.length ? [] : ["--pages", [...games].map(([game, entries]) =>
      game + "=" + entries.join(",")).join(";")];
    const kind = atlasScopeFields[field];
    const restored = parsePolicy({ [field]: args, auto_update: { enable: false } })[kind];
    if (restored.issue || restored.selections.length !== target.length ||
        !restored.selections.every((item, index) => item === target[index])) throw new UnsupportedAtlasScope(field);
    changes[field] = args;
  }
  return changes;
}

export function replaceAtlasScope(text: string, node: Node, field: AtlasScopeField, replacement: string): SourceEdit {
  if (isAlias(node)) return replaceSourceScalar(text, node, replacement);
  if (!isSeq(node) || !node.range || node.anchor || node.items.some(item =>
    item && typeof item === "object" && ("comment" in item && item.comment || "commentBefore" in item && item.commentBefore))) {
    throw new UnsupportedAtlasScope(field);
  }
  const [start, end] = node.range;
  const original = text.slice(start, end);
  const ending = /\r?\n$/u.exec(original)?.[0] ?? "";
  return { start, end, value: replacement + ending };
}
