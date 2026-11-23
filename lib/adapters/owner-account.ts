import type { GroupModerationResult } from "./group-moderation.ts";

export const ownerAccountSession = Symbol("ownerAccountSession");

export const ownerAccountStatus = { "我在线上": 10, "离开": 30, "隐身": 40, "忙碌": 50, "Q我吧": 60, "请勿打扰": 70 } as const;

export type OwnerAccountOperation =
  | { readonly kind: "nickname" | "signature"; readonly text: string }
  | { readonly kind: "status"; readonly status: typeof ownerAccountStatus[keyof typeof ownerAccountStatus] }
  | { readonly kind: "deleteFriend"; readonly userId: number };
type Outcome = GroupModerationResult | "unavailable" | "unsupported" | "notFriend";

export interface OwnerAccountSession {
  readonly signal: AbortSignal;
  readonly isOwner: () => boolean;
  perform(operation: OwnerAccountOperation, signal: AbortSignal, allowed: () => boolean): Promise<Outcome>;
}

export function bindOwnerAccount({ signal, isOwner, actor, privateChat, supported, friends, write }: {
  signal: AbortSignal;
  isOwner: () => boolean;
  actor: number;
  privateChat: boolean;
  supported: (operation: OwnerAccountOperation, signal: AbortSignal) => Promise<boolean>;
  friends: (signal: AbortSignal) => Promise<ReadonlySet<number> | undefined>;
  write: (operation: OwnerAccountOperation, signal: AbortSignal) => Promise<GroupModerationResult>;
}): OwnerAccountSession {
  return {
    signal, isOwner,
    async perform(operation, otherSignal, allowed) {
      const scope = AbortSignal.any([signal, otherSignal]);
      const current = () => !scope.aborted && isOwner() && allowed();
      if (!current()) return "unavailable";
      const available = await supported(operation, scope).catch(() => false);
      if (!current()) return "unavailable";
      if (!available) return "unsupported";
      if (privateChat || operation.kind === "deleteFriend") {
        const existing = await friends(scope).catch(() => undefined);
        if (!current() || !existing || (privateChat && !existing.has(actor))) return "unavailable";
        if (operation.kind === "deleteFriend" && !existing.has(operation.userId)) return "notFriend";
      }
      if (!current()) return "unavailable";
      return write(operation, scope).catch(() => "unknown");
    },
  };
}
