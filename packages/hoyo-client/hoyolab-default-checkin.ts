import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { openHoYoLabCheckinTransport, type HoYoLabCheckinAccount, type HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";

type Json = Record<string, unknown>;

interface DefaultCheckinGame<Biz extends string, Region extends string> {
  readonly gameBiz: Biz;
  readonly name: string;
  readonly activity: string;
  readonly endpoint: string;
  readonly signgame: string;
  readonly regions: readonly Region[];
  readonly uidPattern: RegExp;
  readonly credential: "cookie" | "ltoken";
  readonly perRegionUid?: boolean;
  readonly reportBoundRole?: boolean;
  readonly sendBrowserDevice?: boolean;
}

export interface HoYoLabDefaultRole<Biz extends string, Region extends string> {
  readonly uid: string;
  readonly region: Region;
  readonly gameBiz: Biz;
  readonly chosen?: boolean;
}

export interface HoYoLabDefaultCheckinInfo<Role> {
  readonly signed: boolean;
  readonly firstBind: boolean;
  readonly totalSignDays?: number;
  readonly role?: Role;
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function decimal(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value === "string" && pattern.test(value)) return value;
}

function invalidResponse(subject: string): never {
  throw new HoyoRequestError("response", $t("hoyolab-default-checkin.text_691992adbc", { "subject": subject }));
}

function checkinRole<Biz extends string, Region extends string>(
  data: Json, roles: readonly HoYoLabDefaultRole<Biz, Region>[], game: DefaultCheckinGame<Biz, Region>, subject: string,
) {
  let uid: string | undefined;
  let region: Region | undefined;
  const nested = data.role == null ? undefined : object(data.role) ?? invalidResponse(subject);
  for (const row of nested ? [data, nested] : [data]) {
    for (const key of ["uid", "game_uid", "role_id"]) {
      if (!Object.hasOwn(row, key)) continue;
      const value = decimal(row[key], game.uidPattern);
      if (!value || (uid !== undefined && uid !== value)) invalidResponse(subject);
      uid = value;
    }
    if (Object.hasOwn(row, "region")) {
      const value = game.regions.find(valid => valid === row.region);
      if (!value || (region !== undefined && region !== value)) invalidResponse(subject);
      region = value;
    }
    if (Object.hasOwn(row, "game_biz") && row.game_biz !== game.gameBiz) invalidResponse(subject);
  }

  if (uid === undefined && region === undefined) return;
  const matched = roles.find(role => (uid === undefined || role.uid === uid) && (region === undefined || role.region === region));
  if (!matched) invalidResponse(subject);
  if (game.reportBoundRole && uid !== undefined && region !== undefined) return matched;
}

export async function openHoYoLabDefaultCheckin<Biz extends string, Region extends string>(
  game: DefaultCheckinGame<Biz, Region>, source: HoYoLabCheckinAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  type Role = HoYoLabDefaultRole<Biz, Region>;
  const { gameBiz, activity, endpoint } = game;
  const { language, deviceId, request, roleList } = openHoYoLabCheckinTransport(source, transport, options, game.credential);
  const checkinHeaders = { "x-rpc-signgame": game.signgame };
  const catalogueSubject = $t("hoyolab-default-checkin.text_3661f1e5e0", { "name": game.name });
  const data = await roleList(gameBiz, catalogueSubject);
  const catalogue = new Map<string, Role>();
  for (const entry of data) {
    const row = object(entry) ?? invalidResponse(catalogueSubject);
    const uid = decimal(row.game_uid, game.uidPattern);
    const region = game.regions.find(valid => valid === row.region);
    if (!uid || !region || (row.game_biz !== undefined && row.game_biz !== gameBiz) ||
        (row.is_chosen !== undefined && typeof row.is_chosen !== "boolean")) invalidResponse(catalogueSubject);
    const key = game.perRegionUid ? `${region}:${uid}` : uid;
    if (catalogue.has(key)) invalidResponse(catalogueSubject);
    catalogue.set(key, Object.freeze({ uid, region, gameBiz, ...(row.is_chosen !== undefined && { chosen: row.is_chosen }) }));
  }
  const roles = Object.freeze([...catalogue.values()]);

  let infoRead = 0;
  let canSubmit = false;
  let submitted = false;
  return {
    roles,
    async readInfo(): Promise<HoYoLabDefaultCheckinInfo<Role>> {
      const read = ++infoRead;
      canSubmit = false;
      const subject = $t("hoyolab-default-checkin.text_34486d64ee", { "name": game.name });
      const infoUrl = new URL(`${endpoint}/info`);
      infoUrl.search = new URLSearchParams({ lang: language, act_id: activity }).toString();
      const state = await request(infoUrl, checkinHeaders, subject);
      if (typeof state.is_sign !== "boolean" || (state.first_bind !== undefined && typeof state.first_bind !== "boolean")) {
        invalidResponse(subject);
      }
      const days = state.total_sign_day;
      const totalSignDays = typeof days === "string" && /^\d{1,2}$/u.test(days) ? Number(days) : days;
      if (totalSignDays !== undefined && (typeof totalSignDays !== "number" ||
          !Number.isInteger(totalSignDays) || totalSignDays < 0 || totalSignDays > 31)) invalidResponse(subject);
      const role = checkinRole(state, roles, game, subject);
      if (read === infoRead) canSubmit = !state.is_sign && state.first_bind !== true;
      return { signed: state.is_sign, firstBind: state.first_bind === true,
        ...(totalSignDays !== undefined && { totalSignDays }), ...(role && { role }) };
    },
    async submit({ blockedUids }: { readonly blockedUids: readonly string[] }): Promise<"accepted"> {
      if (submitted || !canSubmit || roles.length === 0) {
        throw new HoyoRequestError("invalid-input", $t("hoyolab-default-checkin.text_dc6c3b9e24", { "name": game.name }));
      }
      // This endpoint selects the account default role. Any matching exclusion blocks the write.
      if (!Array.isArray(blockedUids) || blockedUids.some(uid => typeof uid !== "string" || !/^[1-9]\d{0,19}$/u.test(uid)) ||
          blockedUids.some(uid => roles.some(role => role.uid === uid))) {
        throw new HoyoRequestError("invalid-input", $t("hoyolab-default-checkin.text_85e5969f7c", { "name": game.name }));
      }
      submitted = true;
      const subject = $t("hoyolab-default-checkin.text_2de6071f91", { "name": game.name });
      const signUrl = new URL(`${endpoint}/sign`);
      signUrl.searchParams.set("lang", language);
      const result = await request(signUrl, {
        ...checkinHeaders, "Content-Type": "application/json",
        ...(game.sendBrowserDevice && { "x-rpc-platform": "4", "x-rpc-device_id": deviceId }),
      }, subject, JSON.stringify({ act_id: activity }));
      const risk = result.gt_result == null ? undefined : object(result.gt_result) ?? invalidResponse(subject);
      if (risk?.is_risk !== undefined && risk.is_risk !== false && risk.is_risk !== 0) invalidResponse(subject);
      if (result.first_bind !== undefined && typeof result.first_bind !== "boolean") invalidResponse(subject);
      checkinRole(result, roles, game, subject);
      return "accepted";
    },
  };
}
