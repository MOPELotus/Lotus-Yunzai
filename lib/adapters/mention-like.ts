import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { MessageEvent } from "../messages.ts";

export interface MentionLikeTarget {
  readonly userId: number;
  isFriend(): Promise<boolean>;
  friendship?(): Promise<boolean | undefined>;
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
  send: (count: number) => Promise<number>, friendship?: () => Promise<boolean | undefined>,
): MentionLikeTarget {
  return Object.freeze({
    userId,
    async isFriend() {
      if (signal.aborted || !await member() || signal.aborted) return false;
      return await friend() && !signal.aborted;
    },
    async friendship() {
      if (!friendship || signal.aborted || !await member() || signal.aborted) return;
      const result = await friendship();
      if (!signal.aborted) return result;
    },
    async like(count: number) {
      if (!Number.isInteger(count) || count < 1 || count > 10 || signal.aborted || !await member() || signal.aborted) {
        throw new Error($t("lib.adapters.mention-like.text_ad1a431682"));
      }
      return send(count);
    },
  });
}
