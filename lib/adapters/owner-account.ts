import type { GroupModerationResult } from "./group-moderation.ts";
import { maxGroupAvatarBytes } from "./group-avatar.ts";

export const ownerAccountSession = Symbol("ownerAccountSession");

export const ownerAccountStatus = { "我在线上": 10, "离开": 30, "隐身": 40, "忙碌": 50, "Q我吧": 60, "请勿打扰": 70 } as const;
export const ownerAccountGender = { "无": 0, "男": 1, "女": 2 } as const;

export type OwnerAccountOperation =
  | { readonly kind: "nickname"; readonly text: string }
  | { readonly kind: "signature"; readonly text: string }
  | { readonly kind: "status"; readonly status: typeof ownerAccountStatus[keyof typeof ownerAccountStatus] }
  | { readonly kind: "gender"; readonly gender: typeof ownerAccountGender[keyof typeof ownerAccountGender] }
  | { readonly kind: "avatar"; readonly bytes: Uint8Array }
  | { readonly kind: "deleteFriend"; readonly userId: number };
export type OwnerAccountOutcome = GroupModerationResult | "unavailable" | "unsupported" | "notFriend";
type Authorization = "unavailable" | "unsupported" | "notFriend";

export interface OwnerAccountSession {
  readonly signal: AbortSignal;
  readonly isOwner: () => boolean;
  prepareAvatar(signal: AbortSignal, allowed: () => boolean): Promise<"ready" | Authorization>;
  perform(operation: OwnerAccountOperation, signal: AbortSignal, allowed: () => boolean): Promise<OwnerAccountOutcome>;
}
export function bindOwnerAccount({ signal, isOwner, actor, privateChat, supported, friends, write }: {
  signal: AbortSignal;
  isOwner: () => boolean;
  actor: number;
  privateChat: boolean;
  supported: (kind: OwnerAccountOperation["kind"], signal: AbortSignal) => Promise<boolean>;
  friends: (signal: AbortSignal) => Promise<ReadonlySet<number> | undefined>;
  write: (operation: OwnerAccountOperation, signal: AbortSignal, current: () => boolean) => Promise<OwnerAccountOutcome>;
}): OwnerAccountSession {
  async function authorize(kind: OwnerAccountOperation["kind"], otherSignal: AbortSignal, allowed: () => boolean,
    target?: number): Promise<AbortSignal | Authorization> {
    const scope = AbortSignal.any([signal, otherSignal]);
    const current = () => !scope.aborted && isOwner() && allowed();
    if (!current()) return "unavailable";
    const available = await supported(kind, scope).catch(() => false);
    if (!current()) return "unavailable";
    if (!available) return "unsupported";
    if (privateChat || target !== undefined) {
      const existing = await friends(scope).catch(() => undefined);
      if (!current() || !existing || (privateChat && !existing.has(actor))) return "unavailable";
      if (target !== undefined && !existing.has(target)) return "notFriend";
    }
    return current() ? scope : "unavailable";
  }

  return {
    signal, isOwner,
    async prepareAvatar(otherSignal, allowed) {
      const scope = await authorize("avatar", otherSignal, allowed);
      return typeof scope === "string" ? scope : "ready";
    },
    async perform(operation, otherSignal, allowed) {
      if (operation.kind === "avatar" && (!(operation.bytes instanceof Uint8Array) ||
          !operation.bytes.length || operation.bytes.length > maxGroupAvatarBytes)) return "rejected";
      const scope = await authorize(operation.kind, otherSignal, allowed,
        operation.kind === "deleteFriend" ? operation.userId : undefined);
      if (typeof scope === "string") return scope;
      const current = () => !scope.aborted && isOwner() && allowed();
      if (!current()) return "unavailable";
      return write(operation, scope, current).catch(() => "unknown");
    },
  };
}
