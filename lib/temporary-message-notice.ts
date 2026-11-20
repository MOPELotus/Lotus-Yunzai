import type { InboundSegment, MessageReply } from "./messages.ts";

export interface NativeTemporaryMessageNotice {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly userId: number;
  readonly messageId: number;
  readonly text?: string;
  readonly voice?: InboundSegment;
  readonly groupId?: number;
  readonly reportedGroupId?: number;
  readonly signal: AbortSignal;
  notifyOwners(reply: MessageReply, signal: AbortSignal, followup?: MessageReply): Promise<number>;
}
