import type { OwnerFriendReplyBody, OwnerFriendReplyOutcome } from "./adapters/owner-friend-reply.ts";
import type { MessageReply, QuotedMessage } from "./messages.ts";
import { createPrivateNoticeReceipts, hashPrivateNotice, privateNoticeText,
  type PrivateNoticeReceiptStore, type PrivateNoticeScope } from "./private-notice-receipts.ts";

export const friendMessageNoticeSession = Symbol("friend-message-notice-session");

export interface FriendMessageNoticeSession {
  readonly signal: AbortSignal;
  notifyOwners(message: MessageReply, signal: AbortSignal, onDelivered?: (owner: number, messageId: number) => Promise<void>): Promise<number>;
}

export type QuotedOwnerFriendReplyOutcome = OwnerFriendReplyOutcome | "unrelated" | "expired";

function isFriendId(value: unknown, account: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value !== account;
}

export function createFriendMessageReceipts(getStorage: () => PrivateNoticeReceiptStore | undefined) {
  return createPrivateNoticeReceipts(getStorage, 30 * 86_400, isFriendId);
}

export type FriendMessageReceipts = ReturnType<typeof createFriendMessageReceipts>;

export function bindQuotedOwnerFriendReply(receipts: FriendMessageReceipts, scope: PrivateNoticeScope, active: () => boolean,
  readQuote: () => Promise<QuotedMessage | undefined>, sendReply: (friendId: number, body: OwnerFriendReplyBody) => Promise<OwnerFriendReplyOutcome>) {
  let verifiedQuote: Promise<QuotedMessage | undefined> | undefined;
  return async (body: OwnerFriendReplyBody): Promise<QuotedOwnerFriendReplyOutcome> => {
    if (!active()) return "unrelated";
    const receipt = await receipts.read(scope);
    if (!receipt || !active()) return "unrelated";
    const quote = await (verifiedQuote ??= readQuote().catch(() => undefined));
    if (quote?.user_id !== scope.account || !active()) return "unrelated";
    const text = privateNoticeText(quote.message, true);
    if (!text || hashPrivateNotice(text) !== receipt.noticeHash) return "unrelated";
    if (receipt.expires <= Date.now()) return "expired";
    return sendReply(receipt.origin, body);
  };
}
