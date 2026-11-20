import { createHash } from "node:crypto";
import type { FriendRequest, MessageReply } from "../messages.ts";
import type { PendingFriendRequest, PendingFriendRequestList } from "../friend-requests.ts";

type Approve = (flag: string, action: "accept_friend_request" | "reject_friend_request", params: Record<string, unknown>) =>
  Promise<boolean>;
type SendPrivate = (userId: number, reply: MessageReply) => Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOpaqueUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && value.isWellFormed() &&
    !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function milkyPendingFriendRequests(selfId: number, ordinary: unknown, filtered: unknown): PendingFriendRequestList | undefined {
  const normal = isRecord(ordinary) && Array.isArray(ordinary.requests) ? ordinary.requests : undefined;
  const risk = isRecord(filtered) && Array.isArray(filtered.requests) ? filtered.requests : undefined;
  if (!normal && !risk) return;

  const entries = new Map<string, PendingFriendRequest>();
  const conflicted = new Set<string>();
  for (const [rows, isFiltered] of [[normal, false], [risk, true]] as const) {
    for (const row of rows ?? []) {
      if (!isRecord(row) || row.target_user_id !== selfId || row.state !== "pending" || row.is_filtered !== isFiltered ||
          !isId(row.initiator_id) || row.initiator_id === selfId || !isOpaqueUid(row.initiator_uid) || !isId(row.time)) continue;
      const key = `${row.time}:${row.initiator_uid}`;
      if (conflicted.has(key)) continue;
      const previous = entries.get(key);
      if (previous) {
        if (previous.userId !== row.initiator_id || previous.risk !== isFiltered) {
          entries.delete(key);
          conflicted.add(key);
        }
        continue;
      }
      entries.set(key, { userId: row.initiator_id, time: row.time, risk: isFiltered,
        source: typeof row.via === "string" ? row.via : undefined, comment: typeof row.comment === "string" ? row.comment : undefined });
    }
  }
  // There is no cursor or total, even if both windows return fewer rows than requested.
  return { entries: [...entries.values()].sort((left, right) => (right.time ?? 0) - (left.time ?? 0)), complete: false };
}

export function milkyFriendRequest(
  value: unknown, selfId: number, submit: Approve, sendPrivate: SendPrivate, masterIds: readonly number[],
): FriendRequest | undefined {
  if (!isId(selfId) || !isRecord(value) || value.event_type !== "friend_request" ||
      value.self_id !== selfId || !isRecord(value.data)) return;
  const { initiator_id: userId, initiator_uid: uid, comment } = value.data;
  if (!isId(userId) || userId === selfId || !isOpaqueUid(uid)) return;

  const time = isId(value.time) ? value.time : null;
  const digest = createHash("sha256").update(JSON.stringify([selfId, userId, uid, time])).digest("hex");
  const flag = `milky:friend:${digest}`;
  const recipients = [...new Set(masterIds.filter((id) => isId(id) && id !== selfId))];
  let submitted = false;

  return {
    post_type: "request", request_type: "friend", sub_type: "add",
    self_id: selfId, user_id: userId, flag,
    comment: typeof comment === "string" ? comment : undefined,
    isGroup: false, isPrivate: true, isMaster: false,
    async approve(accept = true, remark) {
      if (submitted || typeof accept !== "boolean") return false;
      if (!accept && remark !== undefined && (typeof remark !== "string" || remark.length > 512)) return false;
      submitted = true;
      if (accept) return submit(flag, "accept_friend_request", { initiator_uid: uid, is_filtered: false });
      return submit(flag, "reject_friend_request", {
        initiator_uid: uid, is_filtered: false, ...(remark === undefined ? {} : { reason: remark }),
      });
    },
    reply: (reply) => sendPrivate(userId, reply),
    async notifyMasters(message) {
      if (typeof message !== "string" || !message) return 0;
      const outcomes = await Promise.allSettled(recipients.map(async (id) => sendPrivate(id, message)));
      return outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value === true).length;
    },
  };
}
