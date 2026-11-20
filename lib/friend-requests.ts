import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readOptionalConfigFile } from "./config.ts";
import type { FriendRequest } from "./messages.ts";
import type { RequestDecisionOutcome } from "./request-claim.ts";

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

export interface PendingFriendRequestDecision {
  readonly status: RequestDecisionOutcome | "submitted" | "not-found" | "ambiguous" | "risk";
}

type FriendAutoResult = "confirmed" | "rejected" | "unknown" | "duplicate" | undefined;

function configuredUsers(value: unknown): Set<number> {
  const entries = Array.isArray(value) ? value : [value];
  return new Set(entries.flatMap(entry => {
    const id = typeof entry === "string" && /^\d+$/u.test(entry.trim()) ? Number(entry) : entry;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? [id] : [];
  }));
}

async function readApprovalPolicy(root: URL): Promise<((userId: number) => boolean) | undefined> {
  const primary = await readOptionalConfigFile(root, "config/other.yaml");
  if (primary && Object.hasOwn(primary, "autoFriend")) {
    if (primary.autoFriend === 1 || primary.autoFriend === "1") return () => true;
    return;
  }
  const legacy = await readOptionalConfigFile(root, "config/config/other.yaml").catch(error => {
    if (!primary) throw error;
    return undefined;
  });
  if (!legacy) return;
  // The TRSS runtime overlay inherited autoFriend: 1 from its bundled defaults.
  const setting = Object.hasOwn(legacy, "autoFriend") ? legacy.autoFriend : 1;
  if (setting !== 1 && setting !== "1" && setting !== true) return;
  const masks: Record<string, unknown> = { blackUser: [528_952_540], ...legacy, ...primary };
  const black = configuredUsers(masks.blackUser);
  const white = configuredUsers(masks.whiteUser);
  return userId => !black.has(userId) && (white.size === 0 || white.has(userId));
}

export async function readFriendRequests(root: URL, delayMs = 3_000) {
  const allows = await readApprovalPolicy(root);
  const pending = new Map<string, AbortSignal | undefined>();
  const unconfirmed = new Set<string>();
  const handled = new Set<string>();
  const maxRequests = 4096;

  return async (event: FriendRequest, workflow?: AbortSignal): Promise<FriendAutoResult> => {
    const connection = event.approvalSignal;
    const signal = workflow && connection ? AbortSignal.any([workflow, connection]) : workflow ?? connection;
    if (!allows?.(event.user_id) || signal?.aborted) return;

    const key = createHash("sha256").update(JSON.stringify([event.adapter ?? "onebot", event.self_id, event.flag])).digest("hex");
    if ((pending.has(key) && pending.get(key)?.aborted !== true) || unconfirmed.has(key) || handled.has(key)) return "duplicate";
    if (!pending.has(key) && pending.size + unconfirmed.size >= maxRequests) return;
    pending.set(key, signal);

    try {
      await delay(delayMs, undefined, { signal });
      if (signal?.aborted) return;
      pending.delete(key);
      unconfirmed.add(key);
      try {
        const approved = await event.approve(true);
        unconfirmed.delete(key);
        handled.add(key);
        if (handled.size > maxRequests) handled.delete(handled.values().next().value!);
        if (approved) return "confirmed";
        console.warn("[好友申请] 协议端未接受自动审批。");
        return "rejected";
      } catch {
        console.warn("[好友申请] 未确认自动审批结果。");
        return "unknown";
      }
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    } finally {
      if (pending.get(key) === signal) pending.delete(key);
    }
  };
}
