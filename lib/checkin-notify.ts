import { segment, type MessageReply } from "./messages.ts";

export interface CheckinNotifySettings {
  readonly enabled: boolean;
  readonly prefer: "private" | "group";
  readonly fallbackGroups: readonly number[];
}

export type CheckinNotifyDelivery = "confirmed" | "rejected" | "unknown";

/** Both membership checks and sends use the same authenticated online session. */
export interface CheckinNotifyTransport {
  readonly isFriend: (userId: number) => Promise<boolean>;
  readonly friendship?: (userId: number) => Promise<boolean | undefined>;
  readonly isGroupMember: (groupId: number, userId: number) => Promise<boolean>;
  readonly sendPrivate: (userId: number, reply: MessageReply) => Promise<CheckinNotifyDelivery>;
  readonly sendGroup: (groupId: number, reply: MessageReply) => Promise<CheckinNotifyDelivery>;
  readonly sendForward?: (target: { readonly groupId: number; readonly userId?: never } |
    { readonly userId: number; readonly groupId?: never }, nodes: readonly MessageReply[]) => Promise<CheckinNotifyDelivery>;
}

export type BotNotifications = CheckinNotifyTransport & { readonly botId: number };

type FinalDelivery = "confirmed" | "unknown";
export type CheckinNotifyResult =
  | { readonly status: "skipped" | "unavailable" }
  | { readonly status: FinalDelivery; readonly channel: "private" }
  | { readonly status: FinalDelivery; readonly channel: "group"; readonly groupId: number };

interface CheckinNotifyOptions {
  readonly userId: number;
  readonly settings: CheckinNotifySettings;
  readonly reply: MessageReply;
  readonly transports: readonly CheckinNotifyTransport[];
  readonly signal?: AbortSignal;
  readonly verifySend?: () => Promise<boolean>;
}

function validId(id: number) {
  return Number.isSafeInteger(id) && id > 0;
}

export async function notifyCheckin({
  userId, settings, reply, transports, signal, verifySend,
}: CheckinNotifyOptions): Promise<CheckinNotifyResult> {
  if (!settings.enabled || signal?.aborted) return { status: "skipped" };
  if (!validId(userId)) return { status: "unavailable" };

  async function attempt(check: () => Promise<boolean>, send: () => Promise<CheckinNotifyDelivery>): Promise<FinalDelivery | undefined> {
    if (signal?.aborted) return;
    let verified: boolean;
    try {
      verified = await check() && !signal?.aborted && (!verifySend || await verifySend());
    } catch {
      return;
    }
    if (verified !== true || signal?.aborted) return;
    try {
      const result = await send();
      if (result === "rejected") return;
      return result === "confirmed" ? "confirmed" : "unknown";
    } catch {
      // A send may have reached the gateway before its connection failed.
      return "unknown";
    }
  }

  if (settings.prefer === "private") {
    for (const transport of transports) {
      if (signal?.aborted) return { status: "skipped" };
      const status = await attempt(() => transport.isFriend(userId), () => transport.sendPrivate(userId, reply));
      if (status) return { status, channel: "private" };
    }
  }

  const groupReply: MessageReply = [segment.at(userId), "\n", ...(Array.isArray(reply) ? reply : [reply])];
  for (const groupId of new Set(settings.fallbackGroups.filter(validId))) {
    for (const transport of transports) {
      if (signal?.aborted) return { status: "skipped" };
      const status = await attempt(() => transport.isGroupMember(groupId, userId), () => transport.sendGroup(groupId, groupReply));
      if (status) return { status, channel: "group", groupId };
    }
  }
  return { status: signal?.aborted ? "skipped" : "unavailable" };
}
