import type { GroupModerationResult } from "./group-moderation.ts";

export const ownerAccountSession = Symbol("ownerAccountSession");

export type OwnerAccountOperation =
  | { readonly kind: "nickname" | "signature"; readonly text: string }
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
  supported: (signal: AbortSignal) => Promise<boolean>;
  friends: (signal: AbortSignal) => Promise<ReadonlySet<number> | undefined>;
  write: (operation: OwnerAccountOperation, signal: AbortSignal) => Promise<GroupModerationResult>;
}): OwnerAccountSession {
  return {
    signal, isOwner,
    async perform(operation, otherSignal, allowed) {
      const scope = AbortSignal.any([signal, otherSignal]);
      const current = () => !scope.aborted && isOwner() && allowed();
      if (!current()) return "unavailable";
      const available = await supported(scope).catch(() => false);
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
