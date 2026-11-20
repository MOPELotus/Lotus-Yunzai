import { createHash } from "node:crypto";

export type RequestDecisionOutcome = "confirmed" | "rejected" | "unknown" | "unavailable";

export interface RequestScope {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly flag: string;
}

export interface RequestClaimStorage {
  claim(key: string, value: string, ttl: number): Promise<boolean>;
  release(key: string, value: string): Promise<void>;
}

const lifetimeSeconds = 3600;
const maxEntries = 4096;

export function createRequestClaim(getStorage: () => RequestClaimStorage | undefined, now = Date.now) {
  const claims = new Map<string, { token: string; expires: number }>();

  return async ({ adapter, botId, flag }: RequestScope, perform: () => Promise<RequestDecisionOutcome>): Promise<RequestDecisionOutcome> => {
    const digest = createHash("sha256").update(flag).digest("hex");
    const key = `decision:${adapter}:${botId}:${digest}`;
    const token = crypto.randomUUID();
    const time = now();
    if ((claims.get(key)?.expires ?? 0) > time) return "unknown";
    claims.delete(key);
    const storage = getStorage();
    if (storage) {
      try {
        if (!await storage.claim(key, token, lifetimeSeconds)) return "unknown";
      } catch {
        return "unavailable";
      }
    } else if (claims.size >= maxEntries) {
      for (const [old, claim] of claims) if (claim.expires <= time) claims.delete(old);
      if (claims.size >= maxEntries) return "unavailable";
    }
    const lease = { token, expires: time + lifetimeSeconds * 1000 };
    if (claims.size >= maxEntries) claims.delete(claims.keys().next().value!);
    claims.set(key, lease);
    const outcome = await perform().catch(() => "unknown" as const);
    if (outcome === "rejected" || outcome === "unavailable") {
      if (claims.get(key) === lease) claims.delete(key);
      await storage?.release(key, token).catch(() => {});
    }
    return outcome;
  };
}
