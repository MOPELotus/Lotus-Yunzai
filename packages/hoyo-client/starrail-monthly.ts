import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export interface StarRailMonthlyOptions {
  readonly signal?: AbortSignal;
  readonly month?: string;
}

interface Income {
  readonly hcoin: number;
  readonly railsPass: number;
}

export interface StarRailMonthlySnapshot {
  readonly month: string;
  readonly monthly: Income;
  readonly today: Income;
  readonly yesterday: Income;
  readonly groups: readonly { readonly name: string; readonly count: number; readonly action?: string }[];
}

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function count(input: unknown) {
  const value = typeof input === "string" && /^\d{1,16}$/u.test(input) ? Number(input) : input;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function income(hcoin: unknown, railsPass: unknown): Income | undefined {
  const h = count(hcoin), r = count(railsPass);
  return h !== undefined && r !== undefined ? { hcoin: h, railsPass: r } : undefined;
}

export async function readStarRailMonthly(source: ProfileRequestContext, transport: HoyoTransport,
  { signal, month }: StarRailMonthlyOptions, verifyProfile?: () => Promise<void>): Promise<{ snapshot: StarRailMonthlySnapshot | null }> {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "starrail-monthly", signal, month }, verifyProfile);
  return { snapshot: normalizeStarRailMonthly(data, { ...source.role, region }, month) };
}

export function normalizeStarRailMonthly(input: unknown,
  identity: Pick<ProfileRequestContext["role"], "uid" | "region" | "gameBiz">, requested?: string): StarRailMonthlySnapshot | null {
  const malformed = () => new HoyoRequestError("response", $t("starrail-monthly.text_1ff0abb12b"));
  const data = object(input);
  if (!data) throw malformed();
  if (!Object.keys(data).length) return null;

  for (const record of [data, object(data.role)]) {
    for (const key of ["uid", "role_id", "game_uid"]) {
      if (record && Object.hasOwn(record, key) && String(record[key]) !== identity.uid) {
        throw new HoyoRequestError("response", $t("starrail-monthly.text_0fd2df4fca"));
      }
    }
    if (record && Object.hasOwn(record, "game_biz") && record.game_biz !== identity.gameBiz) {
      throw new HoyoRequestError("response", $t("starrail-monthly.text_9a7554ed65"));
    }
    for (const key of ["region", "server"]) {
      if (record && Object.hasOwn(record, key) && record[key] !== identity.region) {
        throw new HoyoRequestError("response", $t("starrail-monthly.text_38d5e49a5e"));
      }
    }
  }
  const rawMonth = requested ? data.data_month ?? data.month : data.month ?? data.data_month;
  const month = typeof rawMonth === "string" || typeof rawMonth === "number" ? String(rawMonth) : "";
  if (requested) {
    const validYear = data.data_year === undefined || String(data.data_year) === requested.slice(0, 4);
    const monthKey = month.replace(/-/gu, "");
    const actual = /^(?:0?[1-9]|1[0-2])月?$/u.test(month) && validYear
      ? requested.slice(0, 4) + month.replace(/月$/u, "").padStart(2, "0") : monthKey;
    if (!validYear || actual !== requested) throw new HoyoRequestError("response", $t("starrail-monthly.text_8972dcc0fc"));
  }
  const monthly = object(data.month_data), day = object(data.day_data), groupBy = monthly?.group_by;
  const currentMonth = income(monthly?.current_hcoin, monthly?.current_rails_pass);
  const today = income(day?.current_hcoin, day?.current_rails_pass);
  const yesterday = income(day?.last_hcoin, day?.last_rails_pass);
  if (!/^(?:20\d{2}-?(?:0[1-9]|1[0-2])|(?:0?[1-9]|1[0-2])月?)$/u.test(month) || !currentMonth || !today || !yesterday ||
      !Array.isArray(groupBy) || groupBy.length > 32) throw malformed();
  const groups = groupBy.map(input => {
    const row = object(input);
    const name = row?.action_name;
    const amount = count(row?.num);
    if (typeof name !== "string" || !name.trim() || name.length > 96 || !name.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(name) ||
        amount === undefined) throw malformed();
    const action = typeof row?.action === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(row.action) ? row.action : undefined;
    return { name, count: amount, ...(action && { action }) };
  });
  return { month, monthly: currentMonth, today, yesterday, groups };
}
