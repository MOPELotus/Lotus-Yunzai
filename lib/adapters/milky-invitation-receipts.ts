import { createPrivateNoticeReceipts, type PrivateNoticeReceiptStore, type PrivateNoticeScope } from "../private-notice-receipts.ts";
export { hashPrivateNotice as milkyInvitationNoticeHash } from "../private-notice-receipts.ts";

export interface MilkyInvitationOrigin {
  readonly groupId: number;
  readonly inviterId: number;
  readonly sequence: number;
}

type ReceiptScope = Omit<PrivateNoticeScope, "adapter">;

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isInvitation(value: unknown, account: number): value is MilkyInvitationOrigin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { groupId, inviterId, sequence } = value as Record<string, unknown>;
  return positiveId(groupId) && positiveId(inviterId) && inviterId !== account && positiveId(sequence);
}

export function createMilkyInvitationReceipts(getStorage: () => PrivateNoticeReceiptStore | undefined, now = Date.now) {
  const receipts = createPrivateNoticeReceipts(getStorage, 3600, isInvitation, now);
  return {
    record(scope: ReceiptScope, origin: MilkyInvitationOrigin, message: string) {
      return receipts.record({ ...scope, adapter: "milky" }, origin, message);
    },
    read(scope: ReceiptScope) { return receipts.read({ ...scope, adapter: "milky" }); },
  };
}
