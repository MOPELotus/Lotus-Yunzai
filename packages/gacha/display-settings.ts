import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("gacha", messageCatalog.messages);
import type { GachaProbability } from "./index.ts";

export interface GachaLuckLevel {
  readonly min: number;
  readonly title: string;
  readonly desc: string;
  readonly color: string;
}

const defaultLuckLevels = [
  { min: 99, title: $t("display-settings.text_a8569507ff"), desc: $t("display-settings.text_8c31667950"), color: "#ff7a1f" },
  { min: 95, title: $t("display-settings.text_1ecb75926e"), desc: $t("display-settings.text_7b63bc74b3"), color: "#ff9f1f" },
  { min: 85, title: $t("display-settings.text_e18cd033c7"), desc: $t("display-settings.text_c8c286ff19"), color: "#f5b72a" },
  { min: 70, title: $t("display-settings.text_9b2f026263"), desc: $t("display-settings.text_6e2656563b"), color: "#e4c46a" },
  { min: 55, title: $t("display-settings.text_1f89d9b696"), desc: $t("display-settings.text_b4e4a5e923"), color: "#c9cf8a" },
  { min: 45, title: $t("display-settings.text_810d423654"), desc: $t("display-settings.text_aa38a0cf7b"), color: "#a8c1d8" },
  { min: 25, title: $t("display-settings.text_e1041b2d13"), desc: $t("display-settings.text_b61741407f"), color: "#8f9bd6" },
  { min: 8, title: $t("display-settings.text_8f07b5a57b"), desc: $t("display-settings.text_c3fb5f74cd"), color: "#9a76d8" },
  { min: 0, title: $t("display-settings.text_f2fa5b0b56"), desc: $t("display-settings.text_5aec6cf3f7"), color: "#b0526a" },
] as const satisfies readonly GachaLuckLevel[];

const pools = {
  gs: ["301", "302", "200", "500"],
  sr: ["11", "12", "1"],
} as const;

type GachaGame = keyof typeof pools;
type GachaProbabilityOverrides = {
  readonly [Game in GachaGame]?: Readonly<Partial<Record<(typeof pools)[Game][number], Partial<GachaProbability>>>>;
};

export interface GachaLuckSettings {
  readonly enabled: boolean;
  readonly minSample: number;
  readonly levels: readonly GachaLuckLevel[];
}

export interface GachaDisplaySettings {
  readonly luck: GachaLuckSettings;
  readonly detailRows: number;
  readonly versionRows: number;
  readonly models: GachaProbabilityOverrides;
}

export const defaultGachaDisplaySettings: GachaDisplaySettings = {
  luck: { enabled: true, minSample: 3, levels: defaultLuckLevels },
  detailRows: 30,
  versionRows: 10,
  models: {},
};

function checkedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).every(key => keys.includes(key))) return value as Record<string, unknown>;
  throw new TypeError($t("display-settings.text_ab00f8c507"));
}

function number(value: unknown, min: number, max: number, integer = true): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max &&
      (!integer || Number.isSafeInteger(value))) return value;
  throw new TypeError($t("display-settings.text_26b0e8e5eb"));
}

function label(value: unknown, max: number): string {
  if (typeof value === "string" && value.trim() && value.length <= max && !/[\p{Cc}]/u.test(value)) return value;
  throw new TypeError($t("display-settings.text_5a3274d7a7"));
}

function rating(value: unknown): GachaLuckLevel {
  const level = checkedRecord(value, ["min", "title", "desc", "color"]);
  if (typeof level.color !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/iu.test(level.color)) {
    throw new TypeError($t("display-settings.text_7f72bce77d"));
  }
  return {
    min: number(level.min, 0, 100, false),
    title: label(level.title, 60),
    desc: label(level.desc, 140),
    color: level.color.length === 4 ? "#" + [...level.color.slice(1)].map(character => character.repeat(2)).join("") : level.color,
  };
}

const maxHardPity = 300;
const modelFields = ["base", "soft", "step", "hard", "upRate"] as const;

function parseModel(source: unknown): Partial<GachaProbability> {
  const model = checkedRecord(source, modelFields);
  return Object.fromEntries(modelFields.flatMap(key => {
    if (!Object.hasOwn(model, key)) return [];
    const pity = key === "soft" || key === "hard";
    return [[key, number(model[key], pity ? 1 : 0, pity ? maxHardPity : 1, pity)]];
  }));
}

export function parseGachaDisplaySettings(source: unknown): GachaDisplaySettings {
  const raw = checkedRecord(source, ["enabled", "minSample", "levels", "detailRows", "versionRows", "models"]);
  const { luck, detailRows, versionRows } = defaultGachaDisplaySettings;
  if (Object.hasOwn(raw, "enabled") && typeof raw.enabled !== "boolean") throw new TypeError($t("display-settings.text_bc6a241369"));
  if (Object.hasOwn(raw, "levels") && (!Array.isArray(raw.levels) || raw.levels.length < 1 || raw.levels.length > 100)) {
    throw new TypeError($t("display-settings.text_1afc3bb3bf"));
  }
  const models = Object.hasOwn(raw, "models") ? checkedRecord(raw.models, ["gs", "sr"]) : {};
  return {
    luck: {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : luck.enabled,
      minSample: Object.hasOwn(raw, "minSample") ? number(raw.minSample, 0, Number.MAX_SAFE_INTEGER) : luck.minSample,
      levels: Array.isArray(raw.levels) ? raw.levels.map(rating) : luck.levels,
    },
    detailRows: Object.hasOwn(raw, "detailRows") ? number(raw.detailRows, 0, Number.MAX_SAFE_INTEGER) : detailRows,
    versionRows: Object.hasOwn(raw, "versionRows") ? number(raw.versionRows, 0, Number.MAX_SAFE_INTEGER) : versionRows,
    models: Object.fromEntries(Object.entries(pools).flatMap(([game, ids]) => {
      if (!Object.hasOwn(models, game)) return [];
      const overrides = checkedRecord(models[game], ids);
      return [[game, Object.fromEntries(Object.entries(overrides).map(([pool, model]) => [pool, parseModel(model)]))]];
    })),
  };
}

export function gachaProbabilityFor(game: GachaGame, pool: string | number, base: GachaProbability,
  settings: GachaDisplaySettings | undefined): GachaProbability {
  const update = (settings?.models[game] as Readonly<Record<string, Partial<GachaProbability>>> | undefined)?.[String(pool)];
  return update ? { ...base, ...update } : base;
}
