import type { MessageReply } from "./messages.ts";

export const friendMessageNoticeSession = Symbol("friend-message-notice-session");

export interface FriendMessageNoticeSession {
  readonly signal: AbortSignal;
  notifyOwners(message: MessageReply, signal: AbortSignal): Promise<number>;
}
