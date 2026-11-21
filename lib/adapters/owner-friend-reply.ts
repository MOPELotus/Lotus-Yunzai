import { maxChatFileBytes, readQqMessageSegmentMedia } from "../chat-files.ts";
import type { MessageEvent, MessageReply } from "../messages.ts";
import type { RequestDecisionOutcome } from "../request-claim.ts";

export type OwnerFriendReplyBody = string | readonly (string | { readonly sourceIndex: number })[];
export type OwnerFriendReplyOutcome = "confirmed" | "rejected" | "unknown" | "not-friend" | "unavailable" | "unsupported";
type FriendReplyPart = string | { readonly type: "image"; readonly file: Uint8Array } |
  { readonly type: "face"; readonly data: { readonly id: string | number; readonly is_large?: boolean } };
type RelayReplyPart = FriendReplyPart | { readonly type: "at"; readonly qq: string } |
  { readonly type: "record" | "video"; readonly file: Uint8Array };

interface OwnerFriendReplySession {
  readonly account: number;
  readonly signal: AbortSignal;
  readonly isOwner: () => boolean;
  readonly source: MessageEvent["message"];
  readonly claimDelivery?: (perform: () => Promise<RequestDecisionOutcome>) => Promise<RequestDecisionOutcome>;
  isFriend(userId: number, signal: AbortSignal): Promise<boolean | undefined>;
  send(userId: number, message: MessageReply, signal: AbortSignal): Promise<"confirmed" | "rejected" | "unknown">;
}

export function readFriendReplyParts(body: Exclude<OwnerFriendReplyBody, string>, source: MessageEvent["message"],
  signal: AbortSignal): Promise<FriendReplyPart[] | undefined>;
export function readFriendReplyParts(body: Exclude<OwnerFriendReplyBody, string>, source: MessageEvent["message"],
  signal: AbortSignal, group: boolean): Promise<RelayReplyPart[] | undefined>;
export async function readFriendReplyParts(body: Exclude<OwnerFriendReplyBody, string>, source: MessageEvent["message"],
  signal: AbortSignal, group?: boolean): Promise<RelayReplyPart[] | undefined> {
  if (typeof source === "string" || !Array.isArray(body) || !body.length || body.length > 128) return;
  const parts: RelayReplyPart[] = [];
  let mediaBytes = 0;
  for (const value of body) {
    if (signal.aborted) return;
    if (typeof value === "string") { parts.push(value); continue; }
    if (!value || !Number.isSafeInteger(value.sourceIndex) || value.sourceIndex < 0) return;
    const part = source[value.sourceIndex];
    if (part?.type === "face") {
      const { id, is_large } = part;
      if ((typeof id !== "string" && typeof id !== "number") || !/^\d+$/u.test(String(id)) || !Number.isSafeInteger(Number(id))) return;
      parts.push({ type: "face", data: { id, ...(typeof is_large === "boolean" ? { is_large } : {}) } });
    } else if (part?.type === "image" || (group !== undefined && (part?.type === "record" || part?.type === "audio" || part?.type === "video"))) {
      const bytes = await readQqMessageSegmentMedia(part, signal).catch(() => undefined);
      if (!bytes) return;
      mediaBytes += bytes.byteLength;
      if (mediaBytes > maxChatFileBytes) return;
      parts.push({ type: part.type === "audio" ? "record" : part.type, file: bytes });
    } else if (group && part?.type === "at") {
      const target = typeof part.qq === "string" || typeof part.qq === "number" ? String(part.qq) : "";
      if (target !== "all" && (!/^[1-9]\d*$/u.test(target) || !Number.isSafeInteger(Number(target)))) return;
      parts.push({ type: "at", qq: target });
    } else return;
  }
  return parts;
}

export function bindOwnerFriendReply(session: OwnerFriendReplySession) {
  const { account, signal, isOwner } = session;
  const active = () => !signal.aborted && isOwner();
  return async (userId: number, body: OwnerFriendReplyBody): Promise<OwnerFriendReplyOutcome> => {
    if (!Number.isSafeInteger(userId) || userId < 1 || userId === account || !active()) return "unavailable";
    const lookup = () => session.isFriend(userId, signal).catch(() => undefined);
    const friend = await lookup();
    if (!active() || friend === undefined) return "unavailable";
    if (!friend) return "not-friend";
    const deliver = (message: MessageReply) => {
      const send = async (): Promise<RequestDecisionOutcome> =>
        active() ? session.send(userId, message, signal).catch(() => "unknown") : "unavailable";
      return session.claimDelivery ? session.claimDelivery(send) : send();
    };
    if (typeof body === "string") {
      return body.trim() ? deliver(body) : "unsupported";
    }
    const parts = await readFriendReplyParts(body, session.source, signal);
    if (!active()) return "unavailable";
    if (!parts) return "unsupported";
    const stillFriend = await lookup();
    if (!active() || stillFriend === undefined) return "unavailable";
    if (!stillFriend) return "not-friend";
    return deliver(parts);
  };
}
