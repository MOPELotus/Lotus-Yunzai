import { setTimeout as delay } from "node:timers/promises";
import type { OwnerRequestBatchEntry, OwnerRequestBatchResult } from "../../plugins/group/owner-request-batch.ts";

const maxRequestBatchSize = 50;

export async function reviewObservedBatch<T>(candidates: readonly T[], active: () => boolean, scope: AbortSignal, spacingMs: number,
  id: (candidate: T) => number, review: (candidate: T) => Promise<Omit<OwnerRequestBatchEntry, "id">>): Promise<OwnerRequestBatchResult> {
  if (!candidates.length) return { status: "not-found" };
  if (candidates.length > maxRequestBatchSize) return { status: "unavailable" };
  const entries: OwnerRequestBatchEntry[] = [];
  for (const candidate of candidates) {
    if (entries.length && active()) await delay(spacingMs, undefined, { signal: scope }).catch(() => {});
    const result = active() ? await review(candidate).catch(() => ({ status: "unknown" as const })) : { status: "unavailable" as const };
    entries.push({ id: id(candidate), ...result });
  }
  return { status: "processed", entries };
}
