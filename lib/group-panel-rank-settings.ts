import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { GlobalConfigWriteError, readCanonicalLocalConfiguration, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import type { StygianRankSite } from "./stygian-rank.ts";

const installation = new URL("../", import.meta.url);
const games = ["gs", "sr"] as const;
type Game = (typeof games)[number];
type ListKey = Game | `${Game}Disabled`;
type LimitKey = `${Game}Limit`;
type DefaultKey = `${Game}Default`;
type RankSettings = Record<ListKey, string[]> & Record<LimitKey, number> & Record<DefaultKey, boolean> &
  { artifactListLimit: number; commaGroup: number; stygianArk: boolean; stygianAkasha: boolean };

const defaultGroupPanelRankLimit = 15;
export const maxGroupPanelRankLimit = 30;
const minGroupPanelRankLimit = 5;
export const defaultArtifactListLimit = 28;
const artifactListField = {
  key: "artifactListLimit", label: $t("lib.group-panel-rank-settings.text_a1865cea53"), type: "number", min: 4, max: 100,
  hint: $t("lib.group-panel-rank-settings.text_d154a13e8b"),
} as const;
const commaGroupField = {
  key: "commaGroup", label: $t("lib.group-panel-rank-settings.text_575638439f"), type: "number", min: 1, max: 16,
  hint: $t("lib.group-panel-rank-settings.text_4e03672cf3"),
} as const;

const rankFields = games.flatMap(game => {
  const label = game === "gs" ? $t("lib.group-panel-rank-settings.text_d1597c51ed") : $t("lib.group-panel-rank-settings.text_a2927891f0");
  return [
    { key: `${game}Default`, label: $t("lib.group-panel-rank-settings.text_4098659c2c", { "label": label }), type: "boolean",
      hint: $t("lib.group-panel-rank-settings.text_5ccedf0c84") },
    { key: game, label: $t("lib.group-panel-rank-settings.text_cf039a9bf3", { "label": label }), type: "list" },
    { key: `${game}Disabled`, label: $t("lib.group-panel-rank-settings.text_768caa5899", { "label": label }), type: "list" },
    { key: `${game}Limit`, label: $t("lib.group-panel-rank-settings.text_bbdf13a5f6", { "label": label }), type: "number",
      min: minGroupPanelRankLimit, max: maxGroupPanelRankLimit },
  ] as const;
});
const stygianFields = [
  { key: "stygianArk", label: $t("lib.group-panel-rank-settings.text_2d4ef8badc"), type: "boolean", hint: $t("lib.group-panel-rank-settings.text_4c7fd306f1") },
  { key: "stygianAkasha", label: $t("lib.group-panel-rank-settings.text_45d2e3e684"), type: "boolean", hint: $t("lib.group-panel-rank-settings.text_c4db7e8aa8") },
] as const;
const fields = [artifactListField, commaGroupField, ...rankFields, ...stygianFields];

const legacyRankPolicies = [
  $t("lib.group-panel-rank-settings.text_f203d577d1"),
  $t("lib.group-panel-rank-settings.text_635dc1e483"),
  $t("lib.group-panel-rank-settings.text_0d0f66116a"),
  $t("lib.group-panel-rank-settings.text_2ac0072a74"),
  $t("lib.group-panel-rank-settings.text_3abde73295"),
];

function rankSettingsSnapshot(raw: Readonly<Record<string, unknown>>, values = effective(configured(raw))) {
  const legacyMode = raw.legacyGroupRankLimit;
  const legacyPolicy = typeof legacyMode === "number" && Number.isInteger(legacyMode)
    ? legacyRankPolicies[legacyMode - 1] : undefined;
  const explainedFields = fields.map(field => {
    if (!legacyPolicy || field.key !== "gsDefault") return field;
    return { ...field, hint: $t("lib.group-panel-rank-settings.text_0a19a6b9fa", { "hint": field.hint, "legacyPolicy": legacyPolicy }) };
  });
  return { fields: explainedFields, values };
}

function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 512 || !value.every(id => typeof id === "string" &&
      /^[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id)))) return;
  return [...new Set(value)];
}

export function parseArtifactListLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) &&
      value >= artifactListField.min && value <= artifactListField.max) return value;
}

export function parsePanelCommaGroup(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= commaGroupField.min && value <= commaGroupField.max) {
    return value;
  }
}

export function groupPanelNumber(text: string, grouping: number | undefined): string {
  const size = parsePanelCommaGroup(grouping);
  if (!size) return text;
  const parts = /^([+-]?)(\d+(?:,\d+)*)(\.\d+)?([%％])?$/u.exec(text);
  if (!parts) return text;
  const digits = parts[2]!.replaceAll(",", "");
  const first = digits.length % size || size;
  const groups = [digits.slice(0, first)];
  for (let start = first; start < digits.length; start += size) groups.push(digits.slice(start, start + size));
  return parts[1] + groups.join(",") + (parts[3] ?? "") + (parts[4] ?? "");
}

function configured(record: Readonly<Record<string, unknown>>): Partial<RankSettings> {
  const result: Partial<RankSettings> = {};
  for (const field of fields) {
    const { key, type } = field;
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (type === "list") {
      const groups = list(value);
      if (!groups) throw new GlobalConfigWriteError("config");
      result[key] = groups;
    } else if (type === "number") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) {
        throw new GlobalConfigWriteError("config");
      }
      result[key] = value;
    } else {
      if (typeof value !== "boolean") throw new GlobalConfigWriteError("config");
      result[key] = value;
    }
  }
  return result;
}

function groupsFromEnv(value: string | undefined) {
  return [...new Set((value ?? "").split(/[\s,]+/u).filter(id =>
    /^[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id))))].slice(0, 512);
}

function effective(config: Partial<RankSettings>): RankSettings {
  return {
    gs: config.gs ?? groupsFromEnv(Bun.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS),
    sr: config.sr ?? groupsFromEnv(Bun.env.LOTUS_STAR_RAIL_PANEL_RANK_GROUPS),
    gsDisabled: config.gsDisabled ?? [],
    srDisabled: config.srDisabled ?? [],
    gsDefault: config.gsDefault ?? false,
    srDefault: config.srDefault ?? false,
    gsLimit: config.gsLimit ?? defaultGroupPanelRankLimit,
    srLimit: config.srLimit ?? defaultGroupPanelRankLimit,
    artifactListLimit: config.artifactListLimit ?? defaultArtifactListLimit,
    commaGroup: config.commaGroup ?? 3,
    stygianArk: config.stygianArk ?? true,
    stygianAkasha: config.stygianAkasha ?? true,
  };
}

async function readConfiguration(root: URL) {
  return readCanonicalLocalConfiguration(root, "panel-rank", 65_536);
}

export async function readGroupPanelRankEnabled(game: Game, groupId: number, defaultEnabled: boolean, root = installation) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return false;
  try {
    const raw = await readConfiguration(root);
    const config = configured(raw);
    const id = String(groupId);
    if (config[`${game}Disabled`]?.includes(id)) return false;
    if (config[game]?.includes(id) ?? defaultEnabled) return true;
    if (config[`${game}Default`] !== true) return false;
    if (raw.legacyGroupStatus !== true) return true;
    const legacy = await globalThis.redis?.get(`miao:rank:${id}:cfg`);
    if (!legacy) return true;
    const state: unknown = JSON.parse(legacy);
    return !(state && typeof state === "object" && "status" in state && state.status === 1);
  } catch {
    return false;
  }
}

export async function readGroupPanelRankLimit(game: Game, defaultLimit: number, root = installation) {
  try {
    return configured(await readConfiguration(root))[`${game}Limit`] ?? defaultLimit;
  } catch {
    return defaultLimit;
  }
}

export async function readArtifactListLimit(root = installation) {
  const raw = await readConfiguration(root).catch(() => undefined);
  return parseArtifactListLimit(raw?.artifactListLimit) ?? defaultArtifactListLimit;
}

export async function readPanelCommaGroup(root = installation) {
  const raw = await readConfiguration(root).catch(() => undefined);
  return parsePanelCommaGroup(raw?.commaGroup);
}

export async function readStygianRankSites(root = installation): Promise<readonly StygianRankSite[]> {
  try {
    const config = effective(configured(await readConfiguration(root)));
    return ([["ark", config.stygianArk], ["akasha", config.stygianAkasha]] as const)
      .filter(([, enabled]) => enabled).map(([site]) => site);
  } catch {
    return [];
  }
}

function input(value: unknown): RankSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || !fields.every(({ key }) => Object.hasOwn(value, key))) return;
  try {
    return configured(value as Record<string, unknown>) as RankSettings;
  } catch {
    return undefined;
  }
}

export function panelGroupRankSettings(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      if (request.method === "GET") {
        const snapshot = rankSettingsSnapshot(await readConfiguration(root));
        return active() ? Response.json(snapshot) : new Response(null, { status: 401 });
      }
      const body = await readPanelJson(request).catch(() => undefined);
      if (!body || typeof body !== "object" || !("previous" in body) || !("values" in body)) {
        return new Response(null, { status: 400 });
      }
      const previous = input(body.previous), values = input(body.values);
      if (!previous || !values) return new Response(null, { status: 400 });
      const saved = await updateLocalConfiguration(root, "panel-rank", {
        signal: request.signal, canWrite: active, canCommit: active,
        prepare(text, local) {
          const current = effective(configured(local));
          if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
          const changed = fields.map(({ key }) => key).filter(key => !isDeepStrictEqual(current[key], values[key]));
          if (!changed.length) return { value: rankSettingsSnapshot(local, current) };
          const document = parseDocument(text, { strict: true, uniqueKeys: true });
          if (document.errors.length) throw new GlobalConfigWriteError("config");
          for (const key of changed) document.set(key, values[key]);
          const yaml = document.toString({ lineWidth: 0 });
          if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...local, ...Object.fromEntries(changed.map(key => [key, values[key]])) })) {
            throw new GlobalConfigWriteError("config");
          }
          return { yaml, value: rankSettingsSnapshot(local, values) };
        },
      });
      return Response.json(saved);
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && error.reason === "permission") return new Response(null, { status: 401 });
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
