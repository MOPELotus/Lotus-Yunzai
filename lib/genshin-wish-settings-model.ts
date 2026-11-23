function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export interface WishAllowance {
  readonly pink: number;
  readonly blue: number;
  readonly recallSeconds: number;
}
export interface WishSettings extends WishAllowance {
  readonly privateSingleRecallSeconds: number;
  readonly groups: Readonly<Record<string, Partial<WishAllowance>>>;
}

const keys = ["pink", "blue", "recallSeconds"] as const;
export const wishDefaultSettings: WishSettings = { pink: 100, blue: 10, recallSeconds: 110, privateSingleRecallSeconds: 0,
  groups: { "123465": { pink: 10, blue: 10 } } };

function checkAmount(value: unknown, key: keyof WishAllowance): number {
  const max = key === "recallSeconds" ? 120 : 10_000;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max) return value;
  throw new TypeError(`模拟祈愿设置 ${key} 需为 0–${max} 的整数。`);
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
  const { groups, privateSingleRecallSeconds, ...defaults } = config;
  const fallback = { ...base, ...allowance(defaults),
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
  privateSingle: unknown = wishDefaultSettings.privateSingleRecallSeconds) {
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
  return parseWishSettings({ ...readGroup("default"), groups, privateSingleRecallSeconds: privateSingle });
}
