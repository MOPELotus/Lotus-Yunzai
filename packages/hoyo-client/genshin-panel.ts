import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGenshinGcgSummary } from "./genshin-gcg.ts";
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

function verifyRole(data: Json, uid: string, region: string, label = "原神面板") {
  for (const row of [data, object(data.role)]) {
    if (!row) continue;
    if (["role_id", "game_uid", "uid"].some(key => Object.hasOwn(row, key) && String(row[key]) !== uid) ||
        ["region", "server"].some(key => Object.hasOwn(row, key) && row[key] !== region)) {
      throw new HoyoRequestError("response", `${label}响应的角色或服务器不一致。`);
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

async function readCharacterIds(source: ProfileRequestContext, transport: HoyoTransport,
  signal: AbortSignal | undefined, verifyProfile?: () => Promise<void>) {
  const list = await readCnGameRecord(source, transport, { kind: "genshin-panel-list", signal }, verifyProfile);
  verifyRole(list.data, source.role.uid, list.region);
  const ids = listOf(list.data).map(row => characterId(row.id));
  const characterIds = ids.filter(id => id !== undefined);
  if (ids.length !== characterIds.length || new Set(characterIds).size !== ids.length) {
    throw new HoyoRequestError("response", "原神面板角色编号缺失或重复。");
  }
  return characterIds;
}

async function readCharacterDetails(source: ProfileRequestContext, transport: HoyoTransport, characterIds: readonly number[],
  signal: AbortSignal | undefined, verifyProfile?: () => Promise<void>, allowMissing = false) {
  if (!characterIds.length) return [];
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
  if (!allowMissing && avatars.size !== characterIds.length) throw new HoyoRequestError("response", "原神面板角色详情不完整。");
  return characterIds.flatMap(id => {
    const avatar = avatars.get(id);
    return avatar ? [avatar] : [];
  });
}

export async function readGenshinPanel(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: GenshinPanelOptions, verifyProfile?: () => Promise<void>) {
  const ids = await readCharacterIds(source, transport, signal, verifyProfile);
  return { avatars: await readCharacterDetails(source, transport, ids, signal, verifyProfile) };
}

export function createGenshinPersonalRecordReader(includeRoster: boolean, includeExploration = false) {
  // One reader per caller. Already verified stages can be reused when the same
  // profile retries with its refreshed cookie.
  let overview: Json | undefined;
  let ids: readonly number[] | undefined;
  return async (source: ProfileRequestContext, transport: HoyoTransport, { signal }: GenshinPanelOptions,
    verifyProfile?: () => Promise<void>) => {
    if (!overview) {
      const index = await readCnGameRecord(source, transport, { kind: "genshin-index", signal }, verifyProfile);
      verifyRole(index.data, source.role.uid, index.region);
      overview = index.data;
    }
    if (includeExploration) {
      const gcg = await readGenshinGcgSummary(source, transport, { signal }, verifyProfile).catch(error => {
        if (error instanceof HoyoRequestError && error.retcode === 10102) return undefined;
        throw error;
      });
      return { overview, avatars: [] as readonly Json[], gcg };
    }
    if (!includeRoster) return { overview, avatars: [] as readonly Json[] };
    ids ??= await readCharacterIds(source, transport, signal, verifyProfile);
    return { overview, avatars: await readCharacterDetails(source, transport, ids, signal, verifyProfile) };
  };
}

export async function readGenshinTalents(source: ProfileRequestContext, transport: HoyoTransport,
  { characterIds, signal }: GenshinPanelOptions & { readonly characterIds: readonly number[] }, verifyProfile?: () => Promise<void>) {
  if (new Set(characterIds).size !== characterIds.length) {
    throw new HoyoRequestError("invalid-input", "原神天赋角色编号重复。");
  }
  return { avatars: await readCharacterDetails(source, transport, characterIds, signal, verifyProfile, true) };
}

export type GenshinChallengeOptions = GenshinPanelOptions &
  ({ readonly mode: "abyss"; readonly scheduleType: 1 | 2 } | { readonly mode: "theater" });

export function createGenshinChallengeReader() {
  // A retry for a refreshed Cookie can reuse the verified index of the same owned role.
  let overview: Json | undefined;
  return async (source: ProfileRequestContext, transport: HoyoTransport, options: GenshinChallengeOptions,
    verifyProfile?: () => Promise<void>) => {
    const { signal } = options;
    if (!overview) {
      const index = await readCnGameRecord(source, transport, { kind: "genshin-index", signal }, verifyProfile);
      verifyRole(index.data, source.role.uid, index.region, "原神战绩");
      overview = index.data;
    }
    const { data, region } = await readCnGameRecord(source, transport, options.mode === "abyss"
      ? { kind: "genshin-abyss", scheduleType: options.scheduleType, signal }
      : { kind: "genshin-theater", signal }, verifyProfile);
    verifyRole(data, source.role.uid, region, "原神战绩");
    return { overview, challenge: data };
  };
}
