import type { MessageEvent } from "../messages.ts";

export interface MentionLikeTarget {
  readonly userId: number;
  isFriend(): Promise<boolean>;
  like(count: number): Promise<number>;
}

export type ProfileLikeImage = (userId: number, outcome: "success" | "failure", signal: AbortSignal) => Promise<Uint8Array | undefined>;

export function mentionedProfileId(message: MessageEvent["message"], botId: number, senderId: number): number | undefined {
  if (typeof message === "string") return;
  let target: number | undefined;
  for (const segment of message) {
    if (segment.type !== "at") continue;
    const raw = segment.qq;
    const id = typeof raw === "string" && /^[1-9]\d*$/u.test(raw) ? Number(raw) : raw;
    if (id === botId) continue;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id === senderId || target !== undefined) return;
    target = id;
  }
  return target;
}

export function bindMentionLike(
  userId: number, signal: AbortSignal, member: () => Promise<boolean>, friend: () => Promise<boolean>,
  send: (count: number) => Promise<number>,
): MentionLikeTarget {
  return Object.freeze({
    userId,
    async isFriend() {
      if (signal.aborted || !await member() || signal.aborted) return false;
      return await friend() && !signal.aborted;
    },
    async like(count: number) {
      if (!Number.isInteger(count) || count < 1 || count > 10 || signal.aborted || !await member() || signal.aborted) {
        throw new Error("当前会话无法核实点赞对象。");
      }
      return send(count);
    },
  });
}
