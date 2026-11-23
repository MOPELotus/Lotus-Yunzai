import { bindGroupSettingsAccess, type GroupSettingsScope } from "./group-name.ts";
import type { GroupModerationResult } from "./group-moderation.ts";

export const groupAvatarSession = Symbol("groupAvatarSession");
export const maxGroupAvatarBytes = 6 * 1024 * 1024;

export function inlineAvatar(bytes: Uint8Array) {
  return `base64://${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}

type Availability = "ready" | "unavailable" | "unsupported";

export interface GroupAvatarSession {
  readonly signal: AbortSignal;
  prepare(group: number | undefined, signal: AbortSignal): Promise<Availability>;
  apply(group: number | undefined, bytes: Uint8Array, signal: AbortSignal): Promise<GroupModerationResult | "unavailable">;
}

export function bindGroupAvatar(scope: GroupSettingsScope & {
  readonly available?: (signal: AbortSignal) => Promise<boolean>;
  readonly write: (group: number, inlineImage: string, signal: AbortSignal) => Promise<GroupModerationResult>;
}): GroupAvatarSession {
  const authorize = bindGroupSettingsAccess(scope);
  return {
    signal: scope.signal,
    async prepare(group, signal) {
      const access = await authorize(group, signal);
      if (!access?.active()) return "unavailable";
      if (scope.available && !await scope.available(access.signal)) {
        return access.active() ? "unsupported" : "unavailable";
      }
      return access.active() ? "ready" : "unavailable";
    },
    async apply(group, bytes, signal) {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > maxGroupAvatarBytes) return "rejected";
      const access = await authorize(group, signal);
      if (!access?.active()) return "unavailable";
      return scope.write(access.groupId, inlineAvatar(bytes), access.signal).catch(() => "unknown");
    },
  };
}
