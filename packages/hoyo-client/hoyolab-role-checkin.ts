import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import {
  openHoYoLabCheckinTransport, type HoYoLabCheckinAccount, type HoYoLabCheckinOptions,
} from "./hoyolab-checkin-transport.ts";

const games = {
  starrail: {
    gameBiz: "hkrpg_global", name: $t("hoyolab-role-checkin.text_a2927891f0"), signgame: "hkrpg", activity: "e202303301540311",
    regions: ["prod_official_usa", "prod_official_eur", "prod_official_asia", "prod_official_cht"],
  },
  zzz: {
    gameBiz: "nap_global", name: $t("hoyolab-role-checkin.text_b1110352c9"), signgame: "zzz", activity: "e202406031448091",
    regions: ["prod_gf_jp", "prod_gf_us", "prod_gf_eu", "prod_gf_sg"],
  },
  nxx: {
    gameBiz: "nxx_global", name: $t("hoyolab-role-checkin.text_a6e4fbed57"), signgame: "nxx", activity: "e202202281857121",
    regions: ["glb_prod_wd01"],
  },
} as const;
const decimal = /^[1-9]\d{0,19}$/u;
type Game = keyof typeof games;
type Json = Record<string, unknown>;

export interface HoYoLabBoundRole<G extends Game> {
  readonly uid: string;
  readonly region: typeof games[G]["regions"][number];
  readonly gameBiz: typeof games[G]["gameBiz"];
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
  throw new HoyoRequestError("response", $t("hoyolab-role-checkin.text_691992adbc", { "subject": subject }));
}

function invalidSelection(name: string): never {
  throw new HoyoRequestError("invalid-input", $t("hoyolab-role-checkin.text_7eb2cbbb20", { "name": name }));
}

function verifyRole<G extends Game>(data: Json, { uid, region, gameBiz }: HoYoLabBoundRole<G>, subject: string) {
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

function keyFor({ uid, region }: { readonly uid: string; readonly region: string }) {
  return `${region}:${uid}`;
}

export async function openHoYoLabRoleCheckin<G extends Game>(
  game: G, source: HoYoLabCheckinAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  const { gameBiz, name, signgame, activity, regions } = games[game];
  const endpoint = `https://sg-act-public-api.hoyolab.com/event/luna/${signgame}/os`;
  const readHeaders = { "x-rpc-signgame": signgame };
  const client = openHoYoLabCheckinTransport(source, transport, options, "ltoken");
  const subject = $t("hoyolab-role-checkin.text_3661f1e5e0", { "name": name });
  const catalogue = await client.roleList(gameBiz, subject);
  const attempts = new Map<string, {
    role: HoYoLabBoundRole<G>; read: number; canSubmit: boolean; submitted: boolean;
  }>();
  for (const value of catalogue) {
    const row = object(value) ?? invalidResponse(subject);
    const uid = uidOf(row.game_uid);
    const region = regions.find(valid => row.region === valid) as HoYoLabBoundRole<G>["region"] | undefined;
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
    forRole(selection: { readonly uid: string; readonly region: string }, blockedUids: readonly string[]) {
      if (typeof selection.uid !== "string" || !regions.some(region => region === selection.region)) invalidSelection(name);
      const attempt = attempts.get(keyFor(selection));
      if (!attempt || !Array.isArray(blockedUids) ||
          blockedUids.some(uid => typeof uid !== "string" || !decimal.test(uid) || uid === attempt.role.uid)) invalidSelection(name);
      const { role } = attempt;
      const { uid, region } = role;
      const params = { act_id: activity, uid, region, lang: client.language };
      return {
        async readInfo() {
          const read = ++attempt.read;
          attempt.canSubmit = false;
          const subject = $t("hoyolab-role-checkin.text_34486d64ee", { "name": name });
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
          if (attempt.submitted || !attempt.canSubmit) invalidSelection(name);
          attempt.submitted = true;
          const subject = $t("hoyolab-role-checkin.text_2de6071f91", { "name": name });
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
