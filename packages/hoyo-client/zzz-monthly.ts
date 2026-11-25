import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import type { HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import { openHoYoLabZzzOwnedRecord, type HoYoLabZzzRecordAccount } from "./zzz-game-record.ts";

type Json = Record<string, unknown>;
type Identity = { readonly uid: string; readonly region: string };

export interface ZzzMonthlyRecord extends Identity {
  readonly data_month: string;
  readonly month_data: {
    readonly list: readonly { readonly data_type: string; readonly count: number }[];
    readonly income_components: readonly { readonly action: string; readonly num?: number; readonly percent?: string }[];
  };
}

export function zzzMonthlyKey(value: unknown) {
  const key = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof key === "string" && /^20\d{2}(?:0[1-9]|1[0-2])$/u.test(key) && Number(key) >= 202301) return key;
}

function invalid(field: string): never {
  throw new HoyoRequestError("response", $t("zzz-monthly.text_7310cf1d4e", { "field": field }));
}

function object(value: unknown, field: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Json;
}

function list(value: unknown, field: string, max?: number) {
  if (value == null) return [];
  if (!Array.isArray(value) || (max !== undefined && value.length > max)) invalid(field);
  return value as readonly unknown[];
}

function count(value: unknown, field: string) {
  if (value == null) return;
  const number = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > 999_999_999) invalid(field);
  return number;
}

function code(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,80}$/u.test(value)) invalid(field);
  return value;
}

function percent(value: unknown) {
  if (value == null || value === "") return;
  const string = typeof value === "number" ? String(value) : value;
  if (typeof string !== "string" || !/^\d{1,3}(?:\.\d{1,8})?$/u.test(string) || Number(string) > 100) invalid($t("zzz-monthly.text_efb0768dcf"));
  return string;
}

export function normalizeZzzMonthly(input: unknown, identity: Identity, requested = ""): {
  readonly record?: ZzzMonthlyRecord; readonly month?: string; readonly available: readonly string[]; readonly hasEnvelope: boolean;
} {
  const data = object(input, $t("zzz-monthly.text_3b1f210d39"));
  if (!Object.keys(data).length) return { available: [], hasEnvelope: false } as const;
  if ((typeof data.uid !== "number" && typeof data.uid !== "string") || String(data.uid) !== identity.uid ||
      data.region !== identity.region || (data.game_biz !== undefined && data.game_biz !== "nap_cn" && data.game_biz !== "nap_global")) {
    invalid($t("zzz-monthly.text_2166719b56"));
  }
  if (data.game_biz !== undefined && data.game_biz !== (identity.region.endsWith("_cn") ? "nap_cn" : "nap_global")) invalid($t("zzz-monthly.text_a81ce382a1"));
  const month = zzzMonthlyKey(data.data_month);
  if (!month || (requested && month !== requested)) invalid($t("zzz-monthly.text_91739da90d"));
  const current = data.current_month == null ? undefined : zzzMonthlyKey(data.current_month);
  if (data.current_month != null && !current) invalid($t("zzz-monthly.text_3ab07bf4f4"));
  if (current && month > current) invalid($t("zzz-monthly.text_91739da90d"));
  const available = [...new Set(list(data.optional_month, "可用月份", 36).map(row => {
    const key = zzzMonthlyKey(row);
    if (!key || (current && key > current)) invalid($t("zzz-monthly.text_c5cc2fb874"));
    return key;
  }))];
  if (data.month_data == null) return { month, available, hasEnvelope: true };
  const content = object(data.month_data, $t("zzz-monthly.text_ce65729e0d"));
  const quantities = new Map<string, number>();
  for (const value of list(content.list, $t("zzz-monthly.text_eac8bc429b"), 32)) {
    const row = object(value, $t("zzz-monthly.text_edc50739c0"));
    const type = code(row.data_type, $t("zzz-monthly.text_f68f3cc743"));
    const quantity = count(row.count, $t("zzz-monthly.text_ce04180680"));
    if (quantity === undefined) continue;
    const existing = quantities.get(type);
    if (existing !== undefined && existing !== quantity) invalid($t("zzz-monthly.text_27b6aef8fa"));
    quantities.set(type, quantity);
  }
  const income = list(content.income_components, $t("zzz-monthly.text_54a124e369"), 64).map(value => {
    const row = object(value, $t("zzz-monthly.text_54a124e369"));
    return { action: code(row.action, $t("zzz-monthly.text_a488e93d69")), num: count(row.num, $t("zzz-monthly.text_2b8777184f")), percent: percent(row.percent) };
  });
  const record: ZzzMonthlyRecord = { ...identity, data_month: month,
    month_data: { list: [...quantities].map(([data_type, count]) => ({ data_type, count })), income_components: income } };
  return { month, record, available, hasEnvelope: true };
}

export async function readZzzMonthly(source: ProfileRequestContext, transport: HoyoTransport,
  { month, collect = false, signal }: { readonly month: string; readonly collect?: boolean; readonly signal?: AbortSignal },
  verifyProfile?: () => Promise<void>) {
  const uid = source.role.uid;
  return readMonths(uid, month, collect, async requested => {
    const { data, region } = await readCnGameRecord(source, transport, { kind: "zzz-monthly", month: requested, signal }, verifyProfile);
    return normalizeZzzMonthly(data, { uid, region }, requested);
  });
}

export async function openHoYoLabZzzMonthly(source: HoYoLabZzzRecordAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions) {
  const { role, readMonthly } = await openHoYoLabZzzOwnedRecord(source, transport, options);
  return {
    role,
    read({ month, collect = false }: { readonly month: string; readonly collect?: boolean }) {
      return readMonths(role.uid, month, collect, async requested =>
        normalizeZzzMonthly(await readMonthly(requested), role, requested));
    },
  };
}

async function readMonths(uid: string, month: string, collect: boolean,
  read: (requested: string) => Promise<ReturnType<typeof normalizeZzzMonthly>>) {
  if (month !== "" && zzzMonthlyKey(month) !== month) throw new HoyoRequestError("invalid-input", $t("zzz-monthly.text_281478f903"));
  const initial = await read(month);
  const months = new Map<string, ZzzMonthlyRecord>();
  if (initial.record) months.set(initial.record.data_month, initial.record);
  if (collect) {
    for (const available of initial.available) {
      if (available === initial.month || months.has(available)) continue;
      const item = await read(available);
      if (item.record) months.set(available, item.record);
    }
  }
  return { uid, months: [...months.values()], selectedMonth: initial.month, hasEnvelope: initial.hasEnvelope };
}
