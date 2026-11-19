import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export interface StarRailPanelOptions {
  readonly signal?: AbortSignal;
}

type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

export async function readStarRailPanel(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: StarRailPanelOptions, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "starrail-avatar-info", signal }, verifyProfile);
  for (const record of [data, object(data.role)]) {
    for (const key of ["uid", "role_id", "game_uid"]) {
      if (record && Object.hasOwn(record, key) && String(record[key]) !== source.role.uid) {
        throw new HoyoRequestError("response", "星铁面板响应的角色归属不一致。");
      }
    }
    for (const key of ["region", "server"]) {
      if (record && Object.hasOwn(record, key) && record[key] !== region) {
        throw new HoyoRequestError("response", "星铁面板响应的区服不一致。");
      }
    }
  }
  const avatars = data.avatar_list;
  if (!Array.isArray(avatars) || avatars.length > 256 || avatars.some(avatar => !object(avatar))) {
    throw new HoyoRequestError("response", "星铁面板响应缺少有效角色列表。");
  }
  return { avatars: avatars as Json[] };
}
