import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

type Json = Record<string, unknown>;

export interface GenshinMonthlyOptions {
  readonly month: number;
  readonly signal?: AbortSignal;
}

export interface GenshinMonthlySnapshot {
  readonly month: number;
  readonly primogems: number | undefined;
  readonly mora: number | undefined;
  readonly priorPrimogems: number | undefined;
  readonly priorMora: number | undefined;
  readonly sources: readonly {
    readonly id: number | undefined;
    readonly name: string;
    readonly count: number;
    readonly percent: number | undefined;
  }[];
}

function invalid(): never {
  throw new HoyoRequestError("response", "官方原石札记数据无效。");
}

function whole(value: unknown) {
  if (value == null) return;
  const parsed = typeof value === "string" && /^\d{1,15}$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000_000_000) invalid();
  return parsed;
}

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Json;
}

export function normalizeGenshinMonthly(value: unknown, month: number, uid: string, region: string): GenshinMonthlySnapshot | undefined {
  const data = record(value);
  for (const field of ["uid", "role_id", "bind_uid"]) {
    if (data[field] != null && String(data[field]) !== uid) invalid();
  }
  for (const field of ["region", "bind_region"]) {
    if (data[field] != null && data[field] !== region) invalid();
  }
  if (data.data_month != null && whole(data.data_month) !== month) invalid();
  if (data.month_data == null) return;
  const row = record(data.month_data);
  const grouped = row.group_by ?? [];
  if (!Array.isArray(grouped) || grouped.length > 32) invalid();
  const sources = grouped.map(value => {
    const item = record(value);
    const count = whole(item.num);
    const percent = item.percent == null ? undefined
      : typeof item.percent === "string" && /^\d{1,3}(?:\.\d{1,4})?$/u.test(item.percent)
        ? Number(item.percent) : item.percent;
    const name = typeof item.action === "string" ? item.action.trim() : "";
    if (!name || name.length > 64 || /[\p{Cc}\p{Cf}]/u.test(name) || count === undefined || (percent !== undefined && (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100))) invalid();
    return { id: whole(item.action_id), name, count, percent };
  });
  const primogems = whole(row.current_primogems);
  const mora = whole(row.current_mora);
  const priorPrimogems = whole(row.last_primogems);
  const priorMora = whole(row.last_mora);
  if (!sources.length && [primogems, mora, priorPrimogems, priorMora].every(value => value === undefined)) return;
  return { month, primogems, mora, priorPrimogems, priorMora, sources };
}

export async function readGenshinMonthly(source: ProfileRequestContext, transport: HoyoTransport,
  { month, signal }: GenshinMonthlyOptions, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "genshin-monthly", month, signal }, verifyProfile);
  return { snapshot: normalizeGenshinMonthly(data, month, source.role.uid, region) };
}
