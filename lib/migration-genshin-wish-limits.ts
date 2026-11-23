import { validWishGroup, wishDefaultSettings, maximumWishDailyBatches, type WishDailyDrawLimits } from "./genshin-wish-settings-model.ts";

const defaultCount = 1;
const templateGroup = "123465";
const templateCount = 10;

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function oldInteger(value: unknown, maximum: number) {
  const numeric = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= maximum) return numeric;
}

function oldSeparate(value: unknown) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
}

function explicitFlowerWallet(scope: string, custom: Record<string, unknown> | undefined, stock: Record<string, unknown> | undefined) {
  const details = record(custom?.[scope]);
  const stockScope = record(stock?.[scope]);
  const bundled = scope === "default" ? wishDefaultSettings : wishDefaultSettings.groups[scope];
  return (["pink", "blue"] as const).some(key => {
    const value = oldInteger(details?.[key], 10_000) ?? oldInteger(stockScope?.[key], 10_000);
    return value !== undefined && value !== bundled?.[key];
  });
}

export function migrateWishDailyDrawLimits(legacy: Record<string, unknown> | undefined,
  customCoins: Record<string, unknown> | undefined, stockCoins: Record<string, unknown> | undefined): WishDailyDrawLimits {
  const defaultRow = record(legacy?.default);
  const count = oldInteger(defaultRow?.count, maximumWishDailyBatches) ?? defaultCount;
  const separate = oldSeparate(defaultRow?.LimitSeparate) ?? false;
  const defaultLimit = (count !== defaultCount || separate) && !explicitFlowerWallet("default", customCoins, stockCoins)
    ? { count, separate } : undefined;
  const result: Record<string, WishDailyDrawLimits[string]> = defaultLimit ? { default: defaultLimit } : {};

  for (const [group, value] of Object.entries(legacy ?? {})) {
    if (!validWishGroup(group)) continue;
    const groupRow = record(value);
    const groupCount = oldInteger(groupRow?.count, maximumWishDailyBatches);
    const groupSeparate = oldSeparate(groupRow?.LimitSeparate);
    const explicit = group === templateGroup
      ? (groupCount !== undefined && groupCount !== templateCount) || groupSeparate === true
      : groupCount !== undefined || (groupSeparate !== undefined && groupSeparate !== separate);
    if (explicit) result[group] = { count: groupCount ?? count, separate: groupSeparate ?? separate };
  }
  const walletGroups = new Set([...Object.keys(customCoins ?? {}), ...Object.keys(stockCoins ?? {})]);
  for (const group of walletGroups) {
    if (!validWishGroup(group) || !explicitFlowerWallet(group, customCoins, stockCoins)) continue;
    if (defaultLimit) result[group] = null;
    else delete result[group];
  }
  return result;
}
