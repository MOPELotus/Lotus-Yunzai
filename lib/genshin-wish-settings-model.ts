function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export interface WishAllowance {
  readonly pink: number;
  readonly blue: number;
  readonly recallSeconds: number;
}
export interface WishRates {
  readonly characterFive: number;
  readonly characterFour: number;
  readonly weaponFive: number;
  readonly weaponFour: number;
  readonly featuredFive: number | null;
}

interface WishSwitches {
  readonly enabled: boolean;
  readonly multiple: boolean;
}

export const wishPoolLimits = { poolCharacterFive: 2, poolCharacterFour: 256, poolWeaponFive: 2, poolWeaponFour: 256 } as const;
export type WishPoolKey = keyof typeof wishPoolLimits;
export interface WishManualPools extends Readonly<Record<WishPoolKey, readonly string[]>> {
  readonly automaticPools: boolean;
}

export interface WishSettings extends WishAllowance, WishRates, WishSwitches, WishManualPools {
  readonly privateSingleRecallSeconds: number;
  readonly reincarnationMinutes: number;
  readonly groups: Readonly<Record<string, Partial<WishAllowance>>>;
}

const keys = ["pink", "blue", "recallSeconds"] as const;
export const wishDefaultRates: WishRates = {
  characterFive: 60, characterFour: 510, weaponFive: 70, weaponFour: 600, featuredFive: null,
};
export const wishDefaultPools: WishManualPools = {
  automaticPools: true, poolCharacterFive: [], poolCharacterFour: [], poolWeaponFive: [], poolWeaponFour: [],
};
export const wishDefaultSettings: WishSettings = { ...wishDefaultRates, ...wishDefaultPools, enabled: true, multiple: true, pink: 100, blue: 10, recallSeconds: 110, privateSingleRecallSeconds: 0,
  reincarnationMinutes: 120, groups: { "123465": { pink: 10, blue: 10 } } };

function checkAmount(value: unknown, key: keyof WishAllowance): number {
  const max = key === "recallSeconds" ? 120 : 10_000;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max) return value;
  throw new TypeError(`模拟祈愿设置 ${key} 需为 0–${max} 的整数。`);
}

function rateLimit(key: keyof WishRates) {
  return key === "featuredFive" ? 100 : 10_000;
}

function checkRate(value: unknown, key: keyof WishRates): number {
  const max = rateLimit(key);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max) return value;
  throw new TypeError(`模拟祈愿概率须为 0–${max} 的整数。`);
}

const flowerRates = {
  characterFive: "chance5", characterFour: "chance4", weaponFive: "chanceW5", weaponFour: "chanceW4", featuredFive: "wai",
} as const;

export function legacyWishRules(...rules: readonly (Record<string, unknown> | undefined)[]): Partial<WishRates & WishSwitches> {
  const enabled = rules.map(rule => rule?.enable).find(value => typeof value === "boolean");
  const multiple = rules.map(rule => rule?.more).find(value => typeof value === "boolean");
  const rates = Object.keys(flowerRates).flatMap(name => {
    const key = name as keyof WishRates;
    for (const rule of rules) {
      const stored = rule?.[flowerRates[key]];
      const value = typeof stored === "string" && /^\d+(?:\.\d+)?$/u.test(stored) ? Number(stored) : stored;
      if (typeof value === "number" && value >= 0 && value <= rateLimit(key)) return [[key, Math.floor(value)]];
    }
    return [];
  });
  return { ...(enabled === undefined ? {} : { enabled }), ...(multiple === undefined ? {} : { multiple }),
    ...Object.fromEntries(rates) };
}

export function validWishPoolName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim() && value !== "." && value !== ".." &&
    value.length <= 40 && !/[\/\\\u0000-\u001f]/u.test(value);
}

function poolNames(value: unknown, key: WishPoolKey): readonly string[] {
  if (Array.isArray(value) && value.length <= wishPoolLimits[key] &&
      (key !== "poolWeaponFive" || value.length === 0 || value.length === 2) &&
      value.every(validWishPoolName) && new Set(value).size === value.length) return value;
  throw new TypeError(key === "poolWeaponFive" ? "手工五星武器须为两件不同的武器。"
    : "手工卡池名单须包含有效且不重复的名称。");
}

export function legacyWishPools(source: Record<string, unknown> | undefined, ...rules: readonly (Record<string, unknown> | undefined)[]) {
  const automaticPools = rules.map(rule => rule?.sync).find(value => typeof value === "boolean");
  const from = (...values: readonly unknown[]) => [...new Set(values.flatMap(value => Array.isArray(value) ? value : [])
    .filter(validWishPoolName))];
  const roleFive = from(source?.up5, source?.up5_2).slice(0, 2);
  const weaponFive = from(source?.weapon5);
  const roleFour = from(source?.up4);
  const weaponFour = from(source?.weapon4);
  return {
    ...(automaticPools === undefined ? {} : { automaticPools }),
    ...(roleFive.length ? { poolCharacterFive: roleFive } : {}),
    ...(weaponFive.length === 2 ? { poolWeaponFive: weaponFive } : {}),
    ...(roleFour.length ? { poolCharacterFour: roleFour.slice(0, wishPoolLimits.poolCharacterFour) } : {}),
    ...(weaponFour.length ? { poolWeaponFour: weaponFour.slice(0, wishPoolLimits.poolWeaponFour) } : {}),
  };
}

function validReincarnationMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1440;
}

export function legacyWishReincarnationMinutes(...values: readonly unknown[]) {
  return values.find(validReincarnationMinutes);
}

export function validWishGroup(id: string) {
  return /^[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id));
}

function allowance(value: unknown) {
  const raw = record(value);
  if (!raw || Object.keys(raw).some(key => !keys.includes(key as keyof WishAllowance))) throw new TypeError("群祈愿设置无效。");
  return Object.fromEntries(keys.flatMap(key => Object.hasOwn(raw, key) ? [[key, checkAmount(raw[key], key)]] : []));
}

export function parseWishSettings(value: unknown, base = wishDefaultSettings): WishSettings {
  const config = record(value);
  if (!config) throw new TypeError("模拟祈愿设置应为映射。");
  const {
    groups, privateSingleRecallSeconds, reincarnationMinutes = base.reincarnationMinutes,
    enabled = base.enabled, multiple = base.multiple, characterFive = base.characterFive, characterFour = base.characterFour,
    weaponFive = base.weaponFive, weaponFour = base.weaponFour, featuredFive = base.featuredFive,
    automaticPools = base.automaticPools, poolCharacterFive = base.poolCharacterFive, poolCharacterFour = base.poolCharacterFour,
    poolWeaponFive = base.poolWeaponFive, poolWeaponFour = base.poolWeaponFour, ...defaults
  } = config;
  if (typeof enabled !== "boolean" || typeof multiple !== "boolean" || typeof automaticPools !== "boolean") throw new TypeError("请选择模拟祈愿及多连开关。");
  if (!validReincarnationMinutes(reincarnationMinutes)) throw new TypeError("转生冷却须为 1–1440 分钟的整数。");
  const fallback = { ...base, ...allowance(defaults), reincarnationMinutes, enabled, multiple, automaticPools,
    poolCharacterFive: poolNames(poolCharacterFive, "poolCharacterFive"), poolCharacterFour: poolNames(poolCharacterFour, "poolCharacterFour"),
    poolWeaponFive: poolNames(poolWeaponFive, "poolWeaponFive"), poolWeaponFour: poolNames(poolWeaponFour, "poolWeaponFour"),
    characterFive: checkRate(characterFive, "characterFive"), characterFour: checkRate(characterFour, "characterFour"),
    weaponFive: checkRate(weaponFive, "weaponFive"), weaponFour: checkRate(weaponFour, "weaponFour"),
    featuredFive: featuredFive === null ? null : checkRate(featuredFive, "featuredFive"),
    privateSingleRecallSeconds: Object.hasOwn(config, "privateSingleRecallSeconds")
      ? checkAmount(privateSingleRecallSeconds, "recallSeconds") : base.privateSingleRecallSeconds };
  if (!Object.hasOwn(config, "groups")) return fallback;
  const rows = record(groups);
  if (!rows || Object.keys(rows).length > 2000) throw new TypeError("分群祈愿设置无效。");
  const checked = Object.entries(rows).map(([id, row]) => {
    if (!validWishGroup(id)) throw new TypeError("祈愿群号无效。");
    return [id, allowance(row)];
  });
  return { ...fallback, groups: Object.fromEntries(checked) };
}

export function wishAllowance(settings: WishSettings, group: string): WishAllowance {
  return { pink: settings.pink, blue: settings.blue, recallSeconds: settings.recallSeconds, ...settings.groups[group] };
}

export function inheritWishSettings(coins: Record<string, unknown> | undefined, recall: Record<string, unknown> | undefined,
  privateSingle: unknown = wishDefaultSettings.privateSingleRecallSeconds,
  reincarnationMinutes = wishDefaultSettings.reincarnationMinutes, rules: Partial<WishRates & WishSwitches & WishManualPools> = {}) {
  function readGroup(group: string) {
    const tickets = record(coins?.[group]);
    const delMsg = record(recall?.[group]);
    return {
      ...(tickets?.pink === undefined ? {} : { pink: tickets.pink }),
      ...(tickets?.blue === undefined ? {} : { blue: tickets.blue }),
      ...(delMsg?.delMsg === undefined ? {} : { recallSeconds: delMsg.delMsg }),
    };
  }
  const ids = new Set([...Object.keys(coins ?? {}), ...Object.keys(recall ?? {})]);
  const groups = Object.fromEntries([...ids].filter(validWishGroup).map(group => [group, readGroup(group)]));
  return parseWishSettings({ ...readGroup("default"), groups, privateSingleRecallSeconds: privateSingle, reincarnationMinutes, ...rules });
}
