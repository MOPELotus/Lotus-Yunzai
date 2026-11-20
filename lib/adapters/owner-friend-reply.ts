export type OwnerFriendReplyOutcome = "confirmed" | "rejected" | "unknown" | "not-friend" | "unavailable";

interface OwnerFriendReplySession {
  readonly account: number;
  readonly signal: AbortSignal;
  readonly isOwner: () => boolean;
  isFriend(userId: number, signal: AbortSignal): Promise<boolean | undefined>;
  send(userId: number, text: string, signal: AbortSignal): Promise<"confirmed" | "rejected" | "unknown">;
}

export function bindOwnerFriendReply(session: OwnerFriendReplySession) {
  const { account, signal, isOwner } = session;
  const active = () => !signal.aborted && isOwner();
  return async (userId: number, text: string): Promise<OwnerFriendReplyOutcome> => {
    if (!Number.isSafeInteger(userId) || userId < 1 || userId === account || typeof text !== "string" || !text.trim() || !active()) return "unavailable";
    const friend = await session.isFriend(userId, signal).catch(() => undefined);
    if (!active() || friend === undefined) return "unavailable";
    if (!friend) return "not-friend";
    return session.send(userId, text, signal).catch(() => "unknown");
  };
}
