import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { openHoYoLabCheckinTransport, type HoYoLabCheckinAccount, type HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";

const gameBiz = "hk4e_global";
const activity = "e202102251931481";
const checkinEndpoint = "https://sg-act-public-api.hoyolab.com/event/sol";
const regions = ["os_usa", "os_euro", "os_asia", "os_cht"] as const;
type Region = typeof regions[number];
type Json = Record<string, unknown>;

export type HoYoLabGenshinCheckinSource = HoYoLabCheckinAccount;

export interface HoYoLabGenshinRole {
  readonly uid: string;
  readonly region: Region;
  readonly gameBiz: typeof gameBiz;
  readonly chosen?: boolean;
}

export interface HoYoLabGenshinCheckinInfo {
  readonly signed: boolean;
  readonly firstBind: boolean;
  readonly totalSignDays?: number;
  readonly role?: HoYoLabGenshinRole;
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function asRegion(value: unknown): Region | undefined {
  return regions.find(region => region === value);
}

function decimal(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value === "string" && pattern.test(value)) return value;
}

function roleUid(value: unknown) {
  return decimal(value, /^[1-9]\d{8,9}$/u);
}

function invalidResponse(subject: string): never {
  throw new HoyoRequestError("response", `官方${subject}响应无效。`);
}

function checkinRole(data: Json, roles: ReadonlyMap<string, HoYoLabGenshinRole>, subject: string) {
  let uid: string | undefined;
  let region: Region | undefined;
  const nested = data.role == null ? undefined : object(data.role) ?? invalidResponse(subject);
  for (const row of nested ? [data, nested] : [data]) {
    for (const key of ["uid", "game_uid", "role_id"]) {
      if (!Object.hasOwn(row, key)) continue;
      const value = roleUid(row[key]);
      if (!value || (uid !== undefined && uid !== value)) invalidResponse(subject);
      uid = value;
    }
    if (Object.hasOwn(row, "region")) {
      const value = asRegion(row.region);
      if (!value || (region !== undefined && region !== value)) invalidResponse(subject);
      region = value;
    }
    if (Object.hasOwn(row, "game_biz") && row.game_biz !== gameBiz) invalidResponse(subject);
  }

  const role = uid === undefined ? undefined : roles.get(uid) ?? invalidResponse(subject);
  if (region === undefined) return;
  if (role) {
    if (role.region !== region) invalidResponse(subject);
    return role;
  }
  if (![...roles.values()].some(candidate => candidate.region === region)) invalidResponse(subject);
}

export async function openHoYoLabGenshinCheckin(source: HoYoLabGenshinCheckinSource, transport: HoyoTransport,
  options: HoYoLabCheckinOptions) {
  const { language, deviceId, request, roleList } = openHoYoLabCheckinTransport(source, transport, options);
  const checkinHeaders = { "x-rpc-signgame": "hk4e" };
  const catalogueSubject = "原神国际服角色目录";
  const data = await roleList(gameBiz, catalogueSubject);
  const roles = new Map<string, HoYoLabGenshinRole>();
  for (const entry of data) {
    const row = object(entry) ?? invalidResponse(catalogueSubject);
    const uid = roleUid(row.game_uid);
    const region = asRegion(row.region);
    if (!uid || !region || roles.has(uid) || (row.game_biz !== undefined && row.game_biz !== gameBiz) ||
        (row.is_chosen !== undefined && typeof row.is_chosen !== "boolean")) invalidResponse(catalogueSubject);
    roles.set(uid, Object.freeze({ uid, region, gameBiz, ...(row.is_chosen !== undefined && { chosen: row.is_chosen }) }));
  }

  let infoRead = 0;
  let canSubmit = false;
  let submitted = false;
  return {
    roles: Object.freeze([...roles.values()]),
    async readInfo(): Promise<HoYoLabGenshinCheckinInfo> {
      const read = ++infoRead;
      canSubmit = false;
      const subject = "原神国际服签到状态";
      const infoUrl = new URL(`${checkinEndpoint}/info`);
      infoUrl.search = new URLSearchParams({ lang: language, act_id: activity }).toString();
      const state = await request(infoUrl, checkinHeaders, subject);
      if (typeof state.is_sign !== "boolean" || (state.first_bind !== undefined && typeof state.first_bind !== "boolean")) {
        invalidResponse(subject);
      }
      const days = state.total_sign_day;
      const totalSignDays = typeof days === "string" && /^\d{1,2}$/u.test(days) ? Number(days) : days;
      if (totalSignDays !== undefined && (typeof totalSignDays !== "number" ||
          !Number.isInteger(totalSignDays) || totalSignDays < 0 || totalSignDays > 31)) invalidResponse(subject);
      const role = checkinRole(state, roles, subject);
      if (read === infoRead) canSubmit = !state.is_sign && state.first_bind !== true;
      return { signed: state.is_sign, firstBind: state.first_bind === true,
        ...(totalSignDays !== undefined && { totalSignDays }), ...(role && { role }) };
    },
    async submit({ blockedUids }: { readonly blockedUids: readonly string[] }): Promise<"accepted"> {
      if (submitted || !canSubmit || roles.size === 0) {
        throw new HoyoRequestError("invalid-input", "原神国际服当前账号状态无法发起签到。");
      }
      // This endpoint selects the account default role. Any matching exclusion blocks the write.
      if (!Array.isArray(blockedUids) || blockedUids.some(uid => typeof uid !== "string" || !/^[1-9]\d{0,19}$/u.test(uid)) ||
          blockedUids.some(uid => roles.has(uid))) {
        throw new HoyoRequestError("invalid-input", "原神国际服默认角色无法安全满足签到黑名单。");
      }
      submitted = true;
      const subject = "原神国际服签到提交";
      const signUrl = new URL(`${checkinEndpoint}/sign`);
      signUrl.searchParams.set("lang", language);
      const result = await request(signUrl, {
        ...checkinHeaders, "Content-Type": "application/json", "x-rpc-platform": "4",
        "x-rpc-device_id": deviceId,
      }, subject, JSON.stringify({ act_id: activity }));
      const risk = result.gt_result == null ? undefined : object(result.gt_result) ?? invalidResponse(subject);
      if (risk?.is_risk !== undefined && risk.is_risk !== false && risk.is_risk !== 0) invalidResponse(subject);
      if (result.first_bind !== undefined && typeof result.first_bind !== "boolean") invalidResponse(subject);
      checkinRole(result, roles, subject);
      return "accepted";
    },
  };
}
