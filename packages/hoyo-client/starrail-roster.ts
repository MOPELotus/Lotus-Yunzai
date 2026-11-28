import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import { readStarRailPanel } from "./starrail-panel.ts";

type Json = Record<string, unknown>;

export interface StarRailRosterOptions {
  readonly includeTalents: boolean;
  readonly allowHiddenTalents?: boolean;
  readonly signal?: AbortSignal;
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function safeText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, limit) : "";
}

function identity(data: Json, uid: string, region: string) {
  for (const row of [data, object(data.role)]) {
    for (const field of ["uid", "role_id", "game_uid"]) {
      if (row && Object.hasOwn(row, field) && String(row[field]) !== uid) {
        throw new HoyoRequestError("response", $t("starrail-roster.text_f206effef1"));
      }
    }
    for (const field of ["region", "server"]) {
      if (row && Object.hasOwn(row, field) && row[field] !== region) {
        throw new HoyoRequestError("response", $t("starrail-roster.text_6faec598a4"));
      }
    }
    if (row && Object.hasOwn(row, "game_biz") && row.game_biz !== (region.startsWith("prod_official_") ? "hkrpg_global" : "hkrpg_cn")) {
      throw new HoyoRequestError("response", $t("starrail-roster.text_3b4eb48e81"));
    }
  }
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 && number <= max ? number : undefined;
}

export async function readStarRailPersonalRoster(source: ProfileRequestContext, transport: HoyoTransport,
  { signal, includeTalents, allowHiddenTalents }: StarRailRosterOptions, verifyProfile?: () => Promise<void>) {
  const { uid } = source.role;
  const index = await readCnGameRecord(source, transport, { kind: "starrail-index", signal }, verifyProfile);
  identity(index.data, uid, index.region);
  const basic = await readCnGameRecord(source, transport, { kind: "starrail-avatar-basic", signal }, verifyProfile);
  identity(basic.data, uid, basic.region);
  const rows = basic.data.list ?? basic.data.avatars ?? basic.data.avatar_list;
  if (!Array.isArray(rows) || rows.length > 256 || rows.some(row => !object(row))) {
    throw new HoyoRequestError("response", $t("starrail-roster.text_54b13927db"));
  }
  const role = object(index.data.role);
  const stats = object(index.data.stats);
  const talents = includeTalents && rows.length > 0
    ? await readStarRailPanel(source, transport, { signal }, verifyProfile).then(result => result.avatars, error => {
      if (allowHiddenTalents && error instanceof HoyoRequestError && error.retcode === 10102) return [];
      throw error;
    })
    : [];
  return {
    roster: rows as Json[], talents,
    summary: {
      nickname: safeText(role?.nickname, 60),
      level: count(role?.level, 70),
      avatarId: count(role?.avatar_id ?? role?.head_icon_id, 999_999),
      achievement: count(stats?.achievement_count ?? stats?.achievement_number ?? stats?.achievement_num),
      activeDays: count(stats?.active_days ?? stats?.active_day_number ?? stats?.active_day),
      avatarCount: count(stats?.avatar_num ?? stats?.avatar_number ?? stats?.avatar_count, 256),
    },
  };
}

export type StarRailPersonalRoster = Awaited<ReturnType<typeof readStarRailPersonalRoster>>;
