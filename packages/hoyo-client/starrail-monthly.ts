import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export interface StarRailMonthlyOptions {
  readonly signal?: AbortSignal;
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
  readonly groups: readonly { readonly name: string; readonly count: number }[];
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
  { signal }: StarRailMonthlyOptions, verifyProfile?: () => Promise<void>): Promise<{ snapshot: StarRailMonthlySnapshot | null }> {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "starrail-monthly", signal }, verifyProfile);
  if (!Object.keys(data).length) return { snapshot: null };

  for (const record of [data, object(data.role)]) {
    for (const key of ["uid", "role_id", "game_uid"]) {
      if (record && Object.hasOwn(record, key) && String(record[key]) !== source.role.uid) {
        throw new HoyoRequestError("response", "星铁月收入响应的角色归属不一致。");
      }
    }
    if (record && Object.hasOwn(record, "game_biz") && record.game_biz !== source.role.gameBiz) {
      throw new HoyoRequestError("response", "星铁月收入响应的游戏归属不一致。");
    }
    for (const key of ["region", "server"]) {
      if (record && Object.hasOwn(record, key) && record[key] !== region) {
        throw new HoyoRequestError("response", "星铁月收入响应的区服不一致。");
      }
    }
  }
  const malformed = () => new HoyoRequestError("response", "官方星铁月收入响应缺少有效数据。");
  const month = typeof data.month === "string" || typeof data.month === "number" ? String(data.month) : "";
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
    return { name, count: amount };
  });
  return { snapshot: { month, monthly: currentMonth, today, yesterday, groups } };
}
