import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readLocalConfig } from "./config.ts";
import type { FriendRequest } from "./messages.ts";

export interface PendingFriendRequest {
  readonly userId: number;
  readonly nickname?: string;
  readonly source?: string;
  readonly time?: number;
  readonly comment?: string;
  readonly risk?: boolean;
}

export interface PendingFriendRequestList {
  readonly entries: readonly PendingFriendRequest[];
  readonly complete: boolean;
}

export async function readFriendRequests(root: URL, delayMs = 3_000) {
  const { autoFriend } = await readLocalConfig(root, "other");
  // Existing Lotus-Yunzai installations remain opt-in. TRSS shipped autoFriend: 1.
  const enabled = autoFriend === 1 || autoFriend === "1";
  const pending = new Set<string>();
  const handled = new Set<string>();
  const maxRequests = 4096;

  return async (event: FriendRequest, signal?: AbortSignal): Promise<void> => {
    if (!enabled || signal?.aborted) return;

    const key = createHash("sha256").update(`${event.self_id}\0${event.flag}`).digest("hex");
    if (pending.has(key) || handled.has(key) || pending.size >= maxRequests) return;
    pending.add(key);

    try {
      await delay(delayMs, undefined, { signal });
      if (signal?.aborted) return;
      handled.add(key);
      if (handled.size > maxRequests) handled.delete(handled.values().next().value!);
      try {
        if (!await event.approve(true)) console.warn("[好友申请] 协议端未接受自动审批。");
      } catch {
        console.warn("[好友申请] 未确认自动审批结果。");
      }
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    } finally {
      pending.delete(key);
    }
  };
}
