import { createHash } from "node:crypto";

type Adapter = "onebot" | "milky";
export type JoinReviewOutcome = "confirmed" | "rejected" | "unknown" | "unavailable";
export type QuotedJoinReviewResult = {
  readonly status: JoinReviewOutcome | "expired" | "risk" | "unrelated";
  readonly userId?: number;
  readonly nickname?: string;
};

export interface PendingGroupJoinEntry {
  readonly userId: number;
  readonly nickname?: string;
  readonly comment?: string;
  readonly tip?: string;
  readonly risk?: boolean;
}

export interface PendingGroupJoinList {
  readonly entries: readonly PendingGroupJoinEntry[];
  readonly complete: boolean;
}

export interface PendingGroupJoinDecision {
  readonly status: JoinReviewOutcome | "not-found" | "ambiguous" | "risk" | "expired";
  readonly nickname?: string;
}

interface JoinReviewKey {
  readonly adapter: Adapter;
  readonly botId: number;
  readonly flag: string;
}

interface JoinRequestBase extends JoinReviewKey {
  readonly groupId: number;
  readonly userId: number;
  readonly nickname?: string;
}

export type JoinRequestOrigin = (JoinRequestBase & { readonly adapter: "onebot" }) | (JoinRequestBase & {
  readonly adapter: "milky";
  readonly sequence: number;
  readonly kind: "join_request" | "invited_join_request";
  readonly filtered: boolean;
  readonly inviterId?: number;
});

export interface JoinNoticeQuote {
  readonly adapter: Adapter;
  readonly botId: number;
  readonly groupId: number;
  readonly messageId: number;
}

interface JoinReviewTransport {
  active(): boolean;
  verifyNotice(): Promise<boolean>;
  authorize(): Promise<boolean>;
  verifyPending(origin: JoinRequestOrigin): Promise<"pending" | "expired" | "risk" | "unavailable">;
  submit(origin: JoinRequestOrigin): Promise<JoinReviewOutcome>;
}

interface JoinReviewStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string, ttl: number): Promise<void>;
  claim(key: string, value: string, ttl: number): Promise<boolean>;
  release(key: string, value: string): Promise<void>;
}

interface RecordEntry {
  readonly origin: JoinRequestOrigin;
  readonly expires: number;
}

const lifetimeSeconds = 3600;
const noticeRetention = lifetimeSeconds + 60;
const maxEntries = 4096;

export const isGroupJoinReviewInput = (message: string) => /^#?(?:同意|拒绝)$/u.test(message);

function truthyId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validOrigin(value: unknown): value is JoinRequestOrigin {
  if (!record(value) || !truthyId(value.botId) || !truthyId(value.groupId) || !truthyId(value.userId) ||
      typeof value.flag !== "string" || !value.flag.length || value.flag.length > 4096 ||
      (value.nickname !== undefined && typeof value.nickname !== "string")) return false;
  return value.adapter === "onebot" || (value.adapter === "milky" && truthyId(value.sequence) &&
    typeof value.filtered === "boolean" && (value.kind === "join_request" ||
      (value.kind === "invited_join_request" && truthyId(value.inviterId))));
}

function receiptKey(scope: JoinNoticeQuote) {
  const { adapter, botId, groupId, messageId } = scope;
  if (!truthyId(botId) || !truthyId(groupId) || !Number.isSafeInteger(messageId) ||
      (adapter === "onebot" ? messageId === 0 : messageId < 0)) return;
  return `receipt:${adapter}:${botId}:${groupId}:${messageId}`;
}

function claimKey({ adapter, botId, flag }: JoinReviewKey) {
  const digest = createHash("sha256").update(flag).digest("hex");
  return `decision:${adapter}:${botId}:${digest}`;
}

export function createGroupJoinReview(getStorage: () => JoinReviewStorage | undefined, now = Date.now) {
  const notices = new Map<string, RecordEntry>();
  const claims = new Map<string, { token: string; expires: number }>();

  function remember<T>(container: Map<string, T>, key: string, value: T) {
    if (container.size >= maxEntries) container.delete(container.keys().next().value!);
    container.set(key, value);
  }

  async function once(scope: JoinReviewKey, perform: () => Promise<JoinReviewOutcome>): Promise<JoinReviewOutcome> {
    const key = claimKey(scope);
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
    remember(claims, key, lease);
    const outcome = await perform().catch(() => "unknown" as const);
    if (outcome === "rejected" || outcome === "unavailable") {
      if (claims.get(key) === lease) claims.delete(key);
      await storage?.release(key, token).catch(() => {});
    }
    return outcome;
  }

  return {
    async record(origin: JoinRequestOrigin, messageId: number) {
      const key = receiptKey({ ...origin, messageId });
      if (!key || !validOrigin(origin)) return;
      const entry = { origin, expires: now() + lifetimeSeconds * 1000 };
      remember(notices, key, entry);
      await getStorage()?.write(key, JSON.stringify(entry), noticeRetention);
    },
    once,
    async quoted(scope: JoinNoticeQuote, transport: JoinReviewTransport): Promise<QuotedJoinReviewResult> {
      const key = receiptKey(scope);
      if (!key || !transport.active()) return { status: "unrelated" };
      let entry = notices.get(key);
      if (!entry) {
        try {
          const saved = await getStorage()?.read(key);
          const decoded: unknown = saved && JSON.parse(saved);
          if (record(decoded) && typeof decoded.expires === "number" && Number.isSafeInteger(decoded.expires) && validOrigin(decoded.origin)) {
            entry = { expires: decoded.expires, origin: decoded.origin };
          }
        } catch { return { status: "unrelated" }; }
      }
      const origin = entry?.origin;
      if (!entry || !origin || origin.adapter !== scope.adapter || origin.botId !== scope.botId || origin.groupId !== scope.groupId ||
          !transport.active() || !await transport.verifyNotice().catch(() => false)) return { status: "unrelated" };
      if (entry.expires <= now()) return { status: "expired" };
      if (!await transport.authorize().catch(() => false) || !transport.active()) return { status: "unavailable" };
      const pending = await transport.verifyPending(origin).catch(() => "unavailable" as const);
      if (pending !== "pending") return { status: pending };
      const status = await once(origin, async () => {
        if (!transport.active() || entry.expires <= now() || !await transport.authorize().catch(() => false) ||
            !transport.active()) return "unavailable";
        return transport.submit(origin);
      });
      return { status, userId: origin.userId, nickname: origin.nickname };
    },
  };
}

export async function confirmJoinReview(review: ReturnType<typeof createGroupJoinReview> | undefined, scope: JoinReviewKey,
  submit: () => Promise<boolean>): Promise<boolean> {
  if (!review) return submit();
  const outcome = await review.once(scope, async () => await submit() ? "confirmed" : "rejected");
  if (outcome === "unknown") throw new Error("群请求审批结果未确认。");
  return outcome === "confirmed";
}
