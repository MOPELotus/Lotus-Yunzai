import type { GroupNotice, GroupRequest } from "../messages.ts";

export type GroupModerationResult = "confirmed" | "rejected" | "unknown";

interface GroupModerationSession {
  readonly signal: AbortSignal;
  readonly act?: (signal: AbortSignal) => Promise<GroupModerationResult>;
}

const sessions = new WeakMap<GroupNotice | GroupRequest, GroupModerationSession>();

export function bindGroupModeration(event: GroupNotice | GroupRequest, session: GroupModerationSession): void {
  if (!session.signal.aborted) sessions.set(event, session);
}

export function groupModerationSession(event: GroupNotice | GroupRequest) {
  const session = sessions.get(event);
  return session?.signal.aborted === false ? session : undefined;
}
