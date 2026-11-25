import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { configuredIds } from "./config.ts";
import { otherPolicySetting, readRequestOtherPolicies, requestAutomationSettings, type RequestOtherPolicies } from "./request-other-policies.ts";
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

function approvalPolicy(files: ReturnType<RequestOtherPolicies["current"]>): ((userId: number) => boolean) | undefined {
  const config = otherPolicySetting(files, "autoFriend");
  if (!requestAutomationSettings(files).autoFriend) return;
  if (!config || "primary" in config) return () => true;
  const black = configuredIds(config.legacy.blackUser);
  const white = configuredIds(config.legacy.whiteUser);
  return userId => !black.has(userId) && (white.size === 0 || white.has(userId));
}

export async function readFriendRequests(root: URL, delayMs = 3_000, other?: RequestOtherPolicies) {
  const source = other ?? await readRequestOtherPolicies(root);
  let files = source.current();
  let allows = approvalPolicy(files);
  function admitted(userId: number) {
    const latest = source.current();
    if (files !== latest) {
      files = latest;
      allows = approvalPolicy(files);
    }
    return allows?.(userId) === true;
  }
  const pending = new Map<string, AbortSignal | undefined>();
  const unconfirmed = new Set<string>();
  const handled = new Set<string>();
  const maxRequests = 4096;

  return async (event: FriendRequest, workflow?: AbortSignal, eligible?: () => boolean): Promise<FriendAutoResult> => {
    const connection = event.approvalSignal;
    const signal = workflow && connection ? AbortSignal.any([workflow, connection]) : workflow ?? connection;
    if (!admitted(event.user_id) || signal?.aborted) return;

    const key = createHash("sha256").update(JSON.stringify([event.adapter ?? "onebot", event.self_id, event.flag])).digest("hex");
    if ((pending.has(key) && pending.get(key)?.aborted !== true) || unconfirmed.has(key) || handled.has(key)) return "duplicate";
    if (!pending.has(key) && pending.size + unconfirmed.size >= maxRequests) return;
    pending.set(key, signal);

    try {
      await delay(delayMs, undefined, { signal });
      await source.refresh();
      if (signal?.aborted || !admitted(event.user_id) || eligible?.() === false) return;
      pending.delete(key);
      unconfirmed.add(key);
      try {
        const approved = await event.approve(true);
        unconfirmed.delete(key);
        handled.add(key);
        if (handled.size > maxRequests) handled.delete(handled.values().next().value!);
        if (approved) return "confirmed";
        console.warn($t("lib.friend-requests.text_48c177dc11"));
        return "rejected";
      } catch {
        console.warn($t("lib.friend-requests.text_aae767231b"));
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
