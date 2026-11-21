import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

type Json = Record<string, unknown>;
type Identity = { readonly uid: string; readonly region: string };
export const zzzExplorationColumns = 3;
const rowsPerPage = 7;

interface ZzzCollectionEntry {
  readonly name?: string;
  readonly icon?: string;
  readonly current?: number;
  readonly maximum?: number;
}

export interface ZzzExplorationMap {
  readonly name?: string;
  readonly icon?: string;
  readonly progress?: string;
  readonly collections: readonly ZzzCollectionEntry[];
}

export interface ZzzExplorationArea {
  readonly name?: string;
  readonly progress?: string;
  readonly continued: boolean;
  readonly maps: readonly ZzzExplorationMap[];
}

export interface ZzzExplorationSnapshot extends Identity {
  readonly status: "available" | "empty";
  readonly page: number;
  readonly pageCount: number;
  readonly areas: readonly ZzzExplorationArea[];
}

function invalid(field: string): never {
  throw new HoyoRequestError("response", `官方绝区零区域收集响应的${field}无效。`);
}

function object(value: unknown, field: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Json;
}

function list(value: unknown, field: string): readonly unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid(field);
  return value;
}

function count(value: unknown) {
  if (value == null) return;
  const number = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > 999_999_999) invalid("收集数");
  return number;
}

function progress(value: unknown) {
  if (value == null) return;
  const string = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof string !== "string" || !/^\d{1,3}(?:\.\d{1,8})?$/u.test(string) || Number(string) > 100) invalid("完成度");
  return string;
}

function text(value: unknown, limit = 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const string = value.trim();
  if (string && Buffer.byteLength(string) <= limit) return string;
}

function map(value: unknown): ZzzExplorationMap {
  const item = object(value, "子区域");
  return { name: text(item.name, 144), icon: text(item.icon), progress: progress(item.collection_progress),
    collections: list(item.collections, "收集项").slice(0, 4).map(value => {
      const row = object(value, "收集项");
      return { name: text(row.name, 144), icon: text(row.icon), current: count(row.num), maximum: count(row.total) };
    }) };
}

export function normalizeZzzExploration(input: unknown, identity: Identity, page = 1, whole = false): ZzzExplorationSnapshot {
  if (!Number.isSafeInteger(page) || page < 1 || page > 999_999) {
    throw new HoyoRequestError("invalid-input", "区域收集页码无效。");
  }
  const data = object(input, "格式");
  for (const key of ["uid", "role_id", "game_uid"]) {
    const value = data[key];
    if (value !== undefined && ((typeof value !== "string" && typeof value !== "number") || String(value) !== identity.uid)) {
      invalid("档案 UID");
    }
  }
  for (const key of ["region", "server"]) {
    if (data[key] !== undefined && data[key] !== identity.region) invalid("档案区服");
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid("游戏标识");
  const raw = list(data.area_collections, "区域");
  const first = whole ? 0 : (page - 1) * rowsPerPage;
  const end = whole ? Infinity : first + rowsPerPage;
  const areas: ZzzExplorationArea[] = [];
  let rows = 0;
  for (const entry of raw) {
    const area = object(entry, "区域");
    const maps = list(area.map_collections, "子区域");
    const previous = rows;
    rows += Math.max(1, Math.ceil(maps.length / zzzExplorationColumns));
    if (first >= rows || end <= previous) continue;
    const startIndex = Math.max(0, first - previous) * zzzExplorationColumns;
    const endIndex = Math.min(rows - previous, end - previous) * zzzExplorationColumns;
    areas.push({ name: text(area.name, 144), progress: progress(area.collection_progress), continued: startIndex > 0,
      maps: maps.slice(startIndex, endIndex).map(map) });
  }
  return { ...identity, page, status: raw.length ? "available" : "empty", areas, pageCount: whole ? 1 : Math.max(1, Math.ceil(rows / rowsPerPage)) };
}

/** Create delivery pages from the already verified complete response without a new account request. */
export function splitZzzExploration(snapshot: ZzzExplorationSnapshot, rowsPerPart = rowsPerPage): ZzzExplorationSnapshot[] {
  const rowLimit = Math.max(1, Math.min(rowsPerPage, Math.floor(rowsPerPart) || 1));
  const windows: ZzzExplorationArea[][] = [[]];
  let rows = 0;
  for (const area of snapshot.areas) {
    const totalRows = Math.max(1, Math.ceil(area.maps.length / zzzExplorationColumns));
    for (let placed = 0; placed < totalRows;) {
      if (rows === rowLimit) { windows.push([]); rows = 0; }
      const next = Math.min(totalRows - placed, rowLimit - rows);
      windows.at(-1)!.push({ ...area, continued: area.continued || placed > 0,
        maps: area.maps.slice(placed * zzzExplorationColumns, (placed + next) * zzzExplorationColumns) });
      rows += next;
      placed += next;
    }
  }
  return windows.map((areas, index) => ({ ...snapshot, areas, page: index + 1, pageCount: windows.length }));
}

export async function readZzzExploration(source: ProfileRequestContext, transport: HoyoTransport,
  { page, signal, whole }: { readonly page?: number; readonly signal?: AbortSignal; readonly whole?: boolean }, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "zzz-exploration", signal }, verifyProfile);
  return normalizeZzzExploration(data, { uid: source.role.uid, region }, page, whole === true && page === undefined);
}
