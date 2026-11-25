import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
const active = new Set(["scheduled", "preparing", "submitting"]);
const outcomes = new Set(["unknown", "cancelled", "missed", "succeeded", "failed"]);
const shopId = /^[a-zA-Z0-9_-]{1,100}$/u;
const accountId = /^[1-9]\d{0,19}$/u;
const batchId = /^[0-9a-f]{64}$/u;
const waiting = $t("lib.legacy-write-state.text_aef4a15da9");

type Row = Record<string, unknown>;
type Plan = Row & { id: string; status: string; attempts: number };
type Tracker = Row & { id: string; enabled: boolean };
type Redeem = { time: number; status: "started" | "finished" };

function object(value: unknown): Row | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
}

function nonnegative(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

export function parseWriteStateJson(bytes: Uint8Array): unknown {
  const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(input);
  const scopes: (Set<string> | null)[] = [];
  for (const [token] of input.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}\[\]]/gsu)) {
    if (token === "{") scopes.push(new Set());
    else if (token === "[") scopes.push(null);
    else if (token === "}" || token === "]") scopes.pop();
    else if (token.endsWith(":")) {
      const field = JSON.parse(token.slice(0, -1)) as string;
      const keys = scopes.at(-1);
      if (keys?.has(field)) throw new Error($t("lib.legacy-write-state.text_906e799b50"));
      keys?.add(field);
    }
  }
  return value;
}

function actor(row: Row) {
  return matches(row.id, shopId) && matches(row.qq, accountId) && matches(row.accountId, accountId) &&
    nonnegative(row.profileId) && row.profileId >= 1 && row.profileId <= 255;
}

function unique<T extends { id: string }>(records: T[]) {
  const entries = new Map(records.map(row => [row.id, row]));
  if (entries.size !== records.length) throw new Error($t("lib.legacy-write-state.text_af1e7e94c4"));
  return entries;
}

function ledger(value: unknown) {
  if (value === undefined) return { plans: new Map<string, Plan>(), trackers: new Map<string, Tracker>() };
  const raw = object(value);
  if (!raw || (raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.plans) ||
      (raw.version === 2 && !Array.isArray(raw.trackers)) || (raw.trackers !== undefined && !Array.isArray(raw.trackers))) {
    throw new Error($t("lib.legacy-write-state.text_a672721417"));
  }
  const plans = unique(raw.plans.map(item => {
    const row = object(item);
    if (!row || !actor(row) || !matches(row.goodsId, accountId) || !nonnegative(row.attempts) ||
        typeof row.status !== "string" || (!active.has(row.status) && !outcomes.has(row.status))) {
      throw new Error($t("lib.legacy-write-state.text_9d2d1d6705"));
    }
    return row as Plan;
  }));
  const trackers = unique((raw.trackers ?? []).map((item: unknown) => {
    const row = object(item);
    if (!row || !actor(row) || typeof row.enabled !== "boolean") throw new Error($t("lib.legacy-write-state.text_850337c31b"));
    return row as Tracker;
  }));
  return { plans, trackers };
}

function confirmSameOwner(row: Row, earlier: Row, plan: boolean) {
  if (row.qq !== earlier.qq || row.profileId !== earlier.profileId || row.accountId !== earlier.accountId ||
      (plan && (row.goodsId !== earlier.goodsId || ["createdAt", "type", "gameBiz"].some(field =>
        row[field] !== undefined && earlier[field] !== undefined && row[field] !== earlier[field])))) {
    throw new Error($t("lib.legacy-write-state.text_989e4c2c7c"));
  }
}

function unresolved(row: Plan) {
  return row.status === "unknown" || row.status === "submitting" ||
    (active.has(row.status) && (row.attempts > 0 || row.firstAttemptAt !== undefined));
}

export function prepareLegacyShopWriteState(current: unknown, legacy: unknown) {
  const modern = ledger(current);
  const old = ledger(legacy);
  let kept = 0, held = 0, cancelled = 0, disabled = 0;
  const plans = [...new Set([...modern.plans.keys(), ...old.plans.keys()])].map(id => {
    const next = modern.plans.get(id);
    const previous = old.plans.get(id);
    if (next && previous) confirmSameOwner(next, previous, true);
    const plan = previous?.status === "succeeded" && next && active.has(next.status) && previous.attempts >= next.attempts
      ? previous : (next ?? previous)!;

    // A terminal success in a newer ledger resolves its own outstanding request.
    const completed = plan.status === "succeeded" && (!previous || plan.attempts >= previous.attempts);
    const conflictingEnds = next && previous && outcomes.has(next.status) && outcomes.has(previous.status) &&
      next.status !== previous.status && previous.status !== "unknown";
    const possibleWrite = unresolved(plan) || (previous && unresolved(previous)) ||
      (next && previous && previous.attempts > next.attempts);
    if (conflictingEnds || (!completed && possibleWrite)) {
      held++;
      const { finishedAt: _finalTime, ...pending } = plan;
      return { ...pending, status: "unknown", attempts: Math.max(plan.attempts, previous?.attempts ?? 0), message: waiting };
    }
    if (active.has(plan.status)) {
      cancelled++;
      return { ...plan, status: "cancelled", message: $t("lib.legacy-write-state.text_1d413c0664") };
    }
    kept++;
    return plan;
  });
  const trackers = [...new Set([...modern.trackers.keys(), ...old.trackers.keys()])].map(id => {
    const next = modern.trackers.get(id);
    const previous = old.trackers.get(id);
    if (next && previous) confirmSameOwner(next, previous, false);
    const tracker = (next ?? previous)!;
    if (!tracker.enabled) return tracker;
    disabled++;
    return { ...tracker, enabled: false, message: $t("lib.legacy-write-state.text_d570035b8a") };
  });
  return { data: { version: 2, plans, trackers }, held, cancelled, kept, disabled };
}

function readRedeemLedger(value: unknown, modern: boolean) {
  const entries = new Map<string, Redeem>();
  if (value === undefined) return entries;
  const raw = object(value);
  if (!raw) throw new Error($t("lib.legacy-write-state.text_bca377482c"));
  for (const [key, value] of Object.entries(raw)) {
    if (modern && key === "__lotusPreviewJournalVersion" && value === 1) continue;
    const entry = object(value);
    if (!batchId.test(key) || !entry || !nonnegative(entry.time) ||
        (entry.status !== "started" && entry.status !== "finished")) throw new Error($t("lib.legacy-write-state.text_581a94a14e"));
    entries.set(key, { time: entry.time, status: entry.status });
  }
  return entries;
}

export function prepareLegacyRedeemWriteState(current: unknown, legacy: unknown) {
  const prior = readRedeemLedger(legacy, false);
  const preserved = prior.size;
  for (const [key, entry] of readRedeemLedger(current, true)) {
    if (!prior.has(key)) prior.set(key, entry);
  }
  return { data: Object.fromEntries(prior), preserved, added: prior.size - preserved };
}
