export const qzoneSession = Symbol("qzoneSession");

export interface QzonePost {
  readonly tid: string | undefined;
  readonly content: string;
  readonly time: number;
  readonly comments: number;
  readonly private: boolean;
}

export interface QzonePage {
  readonly posts: readonly QzonePost[];
  readonly total: number;
  readonly totalKnown: boolean;
}

export type QzoneWriteResult<T> = { readonly status: "confirmed"; readonly value: T }
  | { readonly status: "rejected" | "unknown" };

export interface QzoneSession {
  readonly signal: AbortSignal;
  readonly isOwner: () => boolean;
  readonly supported: (signal: AbortSignal) => Promise<boolean>;
  readonly isFriend: (signal: AbortSignal) => Promise<boolean>;
  readonly list: (offset: number, count: number, signal: AbortSignal) => Promise<QzonePage | undefined>;
  readonly publish: (content: string, images: readonly Uint8Array[], signal: AbortSignal) =>
    Promise<QzoneWriteResult<{ readonly time: number }>>;
  readonly remove: (tid: string, signal: AbortSignal) => Promise<QzoneWriteResult<null>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function qzonePostId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function readQzonePage(value: unknown, offset: number, count: number): QzonePage | undefined {
  if (!isRecord(value) || !nonnegativeInteger(value.total) || !Array.isArray(value.msglist) || value.msglist.length > count ||
      (value.total_known !== undefined && typeof value.total_known !== "boolean") ||
      (value.total_known !== false && value.msglist.length && value.total < offset + value.msglist.length)) return;
  const posts: QzonePost[] = [];
  const ids = new Set<string>();
  for (const row of value.msglist) {
    if (!isRecord(row) || !(row.tid === "" || qzonePostId(row.tid)) || typeof row.content !== "string" ||
        !nonnegativeInteger(row.time) || !nonnegativeInteger(row.comment_num) || typeof row.is_private !== "boolean") return;
    const tid = row.tid || undefined;
    if (tid !== undefined) {
      if (ids.has(tid)) return;
      ids.add(tid);
    }
    posts.push({ tid, content: row.content, time: row.time, comments: row.comment_num, private: row.is_private });
  }
  return { posts: posts.sort((left, right) => right.time - left.time), total: value.total, totalKnown: value.total_known !== false };
}

export function readQzonePublishResult(value: unknown) {
  if (isRecord(value) && qzonePostId(value.tid) && nonnegativeInteger(value.time)) return { time: value.time };
}
