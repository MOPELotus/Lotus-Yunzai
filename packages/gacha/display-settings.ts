import type { GachaProbability } from "./index.ts";

export interface GachaLuckLevel {
  readonly min: number;
  readonly title: string;
  readonly desc: string;
  readonly color: string;
}

const defaultLuckLevels = [
  { min: 99, title: "天运所归", desc: "天选之人，建议去买彩票", color: "#ff7a1f" },
  { min: 95, title: "终极欧皇", desc: "金光常伴左右", color: "#ff9f1f" },
  { min: 85, title: "大欧皇", desc: "运气远超常人", color: "#f5b72a" },
  { min: 70, title: "小欧皇", desc: "运气明显好于平均", color: "#e4c46a" },
  { min: 55, title: "小有运气", desc: "运气略好于平均", color: "#c9cf8a" },
  { min: 45, title: "平民", desc: "和理论期望相当", color: "#a8c1d8" },
  { min: 25, title: "小非酋", desc: "运气略差于平均", color: "#8f9bd6" },
  { min: 8, title: "大非酋", desc: "保底常客", color: "#9a76d8" },
  { min: 0, title: "终极非酋", desc: "抱抱，下次一定出金", color: "#b0526a" },
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
  throw new TypeError("抽卡显示设置包含无效字段。");
}

function number(value: unknown, min: number, max: number, integer = true): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max &&
      (!integer || Number.isSafeInteger(value))) return value;
  throw new TypeError("抽卡显示设置的数值超出范围。");
}

function label(value: unknown, max: number): string {
  if (typeof value === "string" && value.trim() && value.length <= max && !/[\p{Cc}]/u.test(value)) return value;
  throw new TypeError("抽卡运势等级文字无效。");
}

function rating(value: unknown): GachaLuckLevel {
  const level = checkedRecord(value, ["min", "title", "desc", "color"]);
  if (typeof level.color !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/iu.test(level.color)) {
    throw new TypeError("抽卡运势等级颜色须为十六进制颜色。");
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
  if (Object.hasOwn(raw, "enabled") && typeof raw.enabled !== "boolean") throw new TypeError("抽卡运势开关无效。");
  if (Object.hasOwn(raw, "levels") && (!Array.isArray(raw.levels) || raw.levels.length < 1 || raw.levels.length > 100)) {
    throw new TypeError("抽卡运势等级须包含 1 到 100 项。");
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
