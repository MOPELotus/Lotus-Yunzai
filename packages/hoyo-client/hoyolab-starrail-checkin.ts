import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import {
  openHoYoLabCheckinTransport, type HoYoLabCheckinAccount, type HoYoLabCheckinOptions,
} from "./hoyolab-checkin-transport.ts";

const gameBiz = "hkrpg_global";
const activity = "e202303301540311";
const endpoint = "https://sg-act-public-api.hoyolab.com/event/luna/hkrpg/os";
const regions = ["prod_official_usa", "prod_official_eur", "prod_official_asia", "prod_official_cht"] as const;
const decimal = /^[1-9]\d{0,19}$/u;
const readHeaders = { "x-rpc-signgame": "hkrpg" };
type Region = typeof regions[number];
type Json = Record<string, unknown>;

export interface HoYoLabStarRailRole {
  readonly uid: string;
  readonly region: Region;
  readonly gameBiz: typeof gameBiz;
  readonly chosen?: boolean;
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function uidOf(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value === "string" && decimal.test(value)) return value;
}

function invalidResponse(subject: string): never {
  throw new HoyoRequestError("response", `官方${subject}响应无效。`);
}

function invalidSelection(): never {
  throw new HoyoRequestError("invalid-input", "星铁国际服签到需要当前 HoYoLAB 档案的绑定角色，并须符合签到黑名单。");
}

function verifyRole(data: Json, { uid, region }: HoYoLabStarRailRole, subject: string) {
  const nested = data.role == null ? undefined : object(data.role) ?? invalidResponse(subject);
  for (const row of nested ? [data, nested] : [data]) {
    if (["uid", "game_uid", "role_id"].some(key => Object.hasOwn(row, key) && uidOf(row[key]) !== uid) ||
        ["region", "server"].some(key => Object.hasOwn(row, key) && row[key] !== region) ||
        (Object.hasOwn(row, "game_biz") && row.game_biz !== gameBiz)) invalidResponse(subject);
  }
}

function verifyRiskFields(data: Json, subject: string) {
  const challenge = data.gt_result == null ? undefined : object(data.gt_result) ?? invalidResponse(subject);
  // The shared transport reports verified risk before returning the payload.
  if ([data.is_risk, challenge?.is_risk].some(flag => flag !== undefined && flag !== false && flag !== 0)) {
    invalidResponse(subject);
  }
}

function keyFor({ uid, region }: Pick<HoYoLabStarRailRole, "uid" | "region">) {
  return `${region}:${uid}`;
}

export async function openHoYoLabStarRailCheckin(
  source: HoYoLabCheckinAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  const client = openHoYoLabCheckinTransport(source, transport, options, "ltoken");
  const subject = "星铁国际服角色目录";
  const catalogue = await client.roleList(gameBiz, subject);
  const attempts = new Map<string, {
    role: HoYoLabStarRailRole; read: number; canSubmit: boolean; submitted: boolean;
  }>();
  for (const value of catalogue) {
    const row = object(value) ?? invalidResponse(subject);
    const uid = uidOf(row.game_uid);
    const region = regions.find(valid => row.region === valid);
    const chosen = row.is_chosen;
    if (!uid || !region || (row.game_biz !== undefined && row.game_biz !== gameBiz) ||
        (chosen !== undefined && typeof chosen !== "boolean")) invalidResponse(subject);
    const role = Object.freeze({ uid, region, gameBiz, ...(chosen !== undefined && { chosen }) });
    const key = keyFor(role);
    if (attempts.has(key)) invalidResponse(subject);
    attempts.set(key, { role, read: 0, canSubmit: false, submitted: false });
  }

  return {
    roles: Object.freeze([...attempts.values()].map(({ role }) => role)),
    forRole(selection: Pick<HoYoLabStarRailRole, "uid" | "region">, blockedUids: readonly string[]) {
      if (typeof selection.uid !== "string" || !regions.includes(selection.region)) invalidSelection();
      const attempt = attempts.get(keyFor(selection));
      if (!attempt || !Array.isArray(blockedUids) ||
          blockedUids.some(uid => typeof uid !== "string" || !decimal.test(uid) || uid === attempt.role.uid)) invalidSelection();
      const { role } = attempt;
      const { uid, region } = role;
      const params = { act_id: activity, uid, region, lang: client.language };
      return {
        async readInfo() {
          const read = ++attempt.read;
          attempt.canSubmit = false;
          const subject = "星铁国际服签到状态";
          const url = new URL(`${endpoint}/info`);
          url.search = new URLSearchParams(params).toString();
          const data = await client.request(url, readHeaders, subject);
          verifyRole(data, role, subject);
          verifyRiskFields(data, subject);
          const { is_sign: signed, first_bind: firstBind, total_sign_day: days } = data;
          const totalSignDays = typeof days === "string" && /^\d{1,2}$/u.test(days) ? Number(days) : days;
          if (typeof signed !== "boolean" || (firstBind !== undefined && typeof firstBind !== "boolean") ||
              (totalSignDays !== undefined && (typeof totalSignDays !== "number" ||
                !Number.isInteger(totalSignDays) || totalSignDays < 0 || totalSignDays > 31))) invalidResponse(subject);
          if (read === attempt.read) attempt.canSubmit = !signed && firstBind !== true;
          return { signed, firstBind: firstBind === true, ...(totalSignDays !== undefined && { totalSignDays }) };
        },
        async submit(): Promise<"accepted"> {
          if (attempt.submitted || !attempt.canSubmit) invalidSelection();
          attempt.submitted = true;
          const subject = "星铁国际服签到提交";
          const url = new URL(`${endpoint}/sign`);
          const data = await client.request(url, {
            ...readHeaders, "Content-Type": "application/json", "x-rpc-platform": "4", "x-rpc-client_type": "5",
            "x-rpc-device_id": client.deviceId, "x-rpc-device_fp": client.deviceId,
          }, subject, JSON.stringify(params));
          verifyRole(data, role, subject);
          verifyRiskFields(data, subject);
          if (data.first_bind !== undefined && typeof data.first_bind !== "boolean") invalidResponse(subject);
          return "accepted";
        },
      };
    },
  };
}
