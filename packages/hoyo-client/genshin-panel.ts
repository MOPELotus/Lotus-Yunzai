import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

type Json = Record<string, unknown>;
export interface GenshinPanelOptions { readonly signal?: AbortSignal }

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function characterId(value: unknown) {
  const id = typeof value === "string" && /^[1-9]\d{0,9}$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

function verifyRole(data: Json, uid: string, region: string) {
  for (const row of [data, object(data.role)]) {
    if (!row) continue;
    if (["role_id", "game_uid", "uid"].some(key => Object.hasOwn(row, key) && String(row[key]) !== uid) ||
        ["region", "server"].some(key => Object.hasOwn(row, key) && row[key] !== region)) {
      throw new HoyoRequestError("response", "原神面板响应的角色或服务器不一致。");
    }
  }
}

function listOf(data: Json): Json[] {
  const list = data.list;
  if (!Array.isArray(list) || list.length > 256 || list.some(value => !object(value))) {
    throw new HoyoRequestError("response", "原神面板响应缺少有效角色列表。");
  }
  return list;
}

export async function readGenshinPanel(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: GenshinPanelOptions, verifyProfile?: () => Promise<void>) {
  const list = await readCnGameRecord(source, transport, { kind: "genshin-panel-list", signal }, verifyProfile);
  verifyRole(list.data, source.role.uid, list.region);
  const ids = listOf(list.data).map(row => characterId(row.id));
  const characterIds = ids.filter(id => id !== undefined);
  if (ids.length !== characterIds.length || new Set(characterIds).size !== ids.length) {
    throw new HoyoRequestError("response", "原神面板角色编号缺失或重复。");
  }
  if (!characterIds.length) return { avatars: [] as readonly Json[] };
  const detail = await readCnGameRecord(source, transport, { kind: "genshin-panel-detail", characterIds, signal }, verifyProfile);
  verifyRole(detail.data, source.role.uid, detail.region);
  const avatars = new Map<number, Json>();
  for (const row of listOf(detail.data)) {
    const id = characterId(object(row.base)?.id);
    if (id === undefined || !characterIds.includes(id) || avatars.has(id)) {
      throw new HoyoRequestError("response", "原神面板详情中的角色编号不一致。");
    }
    avatars.set(id, row);
  }
  if (avatars.size !== characterIds.length) throw new HoyoRequestError("response", "原神面板角色详情不完整。");
  return { avatars: characterIds.map(id => avatars.get(id)!) };
}
