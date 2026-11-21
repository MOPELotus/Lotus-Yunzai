import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import type { createCheckinScheduleStore } from "./checkin-schedule-store.ts";
import { checkinHandbackHoldStage, checkinScheduleClock, legacyUnconfirmedStage, parseCheckinSchedulePlan,
  type CheckinCommunityWriteStatus, type CheckinScheduleEntry, type CheckinScheduleGame, type CheckinSchedulePlan } from "./checkin-schedule-plan.ts";

export const checkinHandbackVersions = ["e28c6df", "5aa3a70"] as const;
type LegacyVersion = typeof checkinHandbackVersions[number];

type Entry = CheckinScheduleEntry;
type ProfileIdentity = Pick<Entry, "qq" | "profileId">;
type Retry = NonNullable<Entry["communityRetry"]>;
type AccountView = ProfileAccountContext & { readonly checkinTargets?: {
  readonly forums: readonly string[];
  readonly games: readonly string[];
} };
type GetAccount = (qq: string, profileId: number) => Promise<AccountView | undefined>;

function entryKey({ qq, profileId }: ProfileIdentity) {
  return `${qq}/${profileId}`;
}

function settled({ runningAt: _running, communityRetry: _retry, communityWrites: _writes, communityWriteAccount: _owner,
  gameWrites: _games, gameWriteAccount: _gameOwner, gameWritesUnknown: _unknownGames, ...entry }: Entry) {
  return entry;
}

function held(entry: Entry): Entry {
  return { ...settled(entry), done: true, ok: false, stage: checkinHandbackHoldStage, message: "交还时签到结果待核对。" };
}

function hasProgress(entry: Entry) {
  return !!(entry.runningAt || entry.communityRetry || entry.communityWrites || entry.communityWriteAccount ||
    entry.gameWriteAccount || entry.gameWritesUnknown || entry.doneAt || entry.ok !== undefined || entry.stage);
}

function canRetryForum(status: Entry["communityWrites"], forum: string) {
  return status?.[forum] === undefined || status[forum] === "retryable";
}

function gameVerifiedUnsent(entry: Entry, game: CheckinScheduleGame) {
  return !entry.gameWritesUnknown && !Object.keys(entry.gameWrites ?? {}).some(key => key.startsWith(`${game}:cn:`));
}

function hasUnresolvedGameWrite(entry: Entry) {
  return entry.gameWritesUnknown || Object.values(entry.gameWrites ?? {}).some(status => status !== "confirmed");
}

function hash(fields: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function identity(entry: ProfileIdentity, current: ProfileAccountContext | undefined) {
  if (!current || current.qq !== entry.qq || current.profileId !== entry.profileId) return;
  const { stuid, ltuid, mid } = current.account;
  if ((!stuid && !ltuid) || (stuid && ltuid && stuid !== ltuid)) return;
  const fields = [entry.qq, entry.profileId, stuid || ltuid];
  return { accountKey: hash(fields), previousKey: hash([...fields, mid]) };
}

function matchesAccount(entry: ProfileIdentity, key: string | undefined, current: ProfileAccountContext | undefined) {
  const owner = identity(entry, current);
  return !!owner && (owner.accountKey === key || owner.previousKey === key);
}

/** Supply accountAtExecution only from a guardian of the actual old run, after matching its pending call. */
export async function prepareLegacyCheckinSchedule(
  source: CheckinSchedulePlan, legacy: CheckinSchedulePlan | undefined, target: LegacyVersion,
  { now = Date.now(), accountAtExecution }: { readonly now?: number; readonly accountAtExecution?: GetAccount } = {},
) {
  if (legacy && legacy.date !== source.date) throw new Error("新旧签到计划日期不一致。");
  const today = checkinScheduleClock(now).date;
  const earlier = new Map(legacy?.entries.map(entry => [entryKey(entry), entry]));
  const currentEntries = new Set(source.entries.map(entryKey));
  const counts = { completed: 0, unstarted: 0, held: 0, heldRetries: 0, unsupportedGames: 0, pendingGames: 0, pendingForums: 0 };
  const entries: Entry[] = [];
  for (const candidate of [...source.entries, ...(legacy?.entries.filter(entry => !currentEntries.has(entryKey(entry))) ?? [])]) {
    const previous = earlier.get(entryKey(candidate));
    const retry = candidate.communityRetry;
    if (candidate.done || previous?.done) {
      counts.completed++;
      entries.push(settled(candidate.done ? candidate : previous!));
      continue;
    }
    if (target === "e28c6df") counts.unsupportedGames += retry?.games?.length ?? 0;
    if (candidate.runningAt || (previous && hasProgress(previous) && !isDeepStrictEqual(previous, candidate))) {
      counts.held++;
      if (retry || previous?.communityRetry) counts.heldRetries++;
      entries.push(held(candidate));
      continue;
    }
    if (retry) {
      // The fixed legacy readers cannot enforce account identity on their own.
      // Keep a mixed retry together if the old reader cannot reconcile its game targets.
      const representable = target === "5aa3a70" || !retry.games?.length;
      const current = representable && accountAtExecution && source.date === today && retry.verifiedUnsent &&
        checkinScheduleClock(Date.parse(retry.nextAt)).date === today &&
        await accountAtExecution(candidate.qq, candidate.profileId);
      if (current && matchesAccount(candidate, retry.accountKey, current)) {
        const forums = retry.forums.filter(forum => canRetryForum(candidate.communityWrites, forum));
        const games = retry.games?.filter(game => gameVerifiedUnsent(candidate, game));
        if (forums.length || games?.length) {
          counts.pendingForums += forums.length;
          counts.pendingGames += games?.length ?? 0;
          const unresolved = hasUnresolvedGameWrite(candidate) || games?.length !== retry.games?.length || Object.values(candidate.communityWrites ?? {}).some(status =>
            status === "pending" || status === "unconfirmed" || status === "rejected" || status === "blocked");
          entries.push({ ...settled(candidate), communityRetry: {
            forums, ...(games?.length && { games }), attempts: retry.attempts, nextAt: retry.nextAt,
            ...(retry.otherFailure || unresolved ? { otherFailure: true } : {}),
          } });
          continue;
        }
      }
      counts.held++;
      counts.heldRetries++;
      entries.push(held(candidate));
    } else if (hasProgress(candidate) || source.date < today) {
      counts.held++;
      entries.push(held(candidate));
    } else {
      counts.unstarted++;
      entries.push(settled(candidate));
    }
  }
  return { plan: { ...source, entries }, counts };
}

const receiptProtocol = "lotus-checkin-handback/1";
export const guardedCheckinLegacyVersion = "5aa3a7058885e7879b4e9bb1fc6b89b28cbe3a1e";
type ReceiptTarget = `community:${string}` | `game:${CheckinScheduleGame}`;
type ReceiptStatus = "completed" | "unsent" | "unknown" | "stopped";
export type ReceiptTransfer = {
  readonly protocol: typeof receiptProtocol;
  readonly version: typeof guardedCheckinLegacyVersion;
  readonly date: string;
  readonly id: string;
  readonly planDigest: string;
  readonly entries: readonly {
    readonly qq: string;
    readonly profileId: number;
    readonly accountKey: string;
    readonly retry: Retry;
    readonly targets: readonly ReceiptTarget[];
  }[];
};

type ReceiptEntry = {
  readonly qq: string;
  readonly profileId: number;
  readonly accountKey: string;
  readonly attempts: number;
  readonly nextAt?: string;
  readonly outcomes: readonly { readonly target: ReceiptTarget; readonly status: ReceiptStatus }[];
};

type Receipt = Omit<ReceiptTransfer, "entries"> & { readonly entries: readonly ReceiptEntry[] };
type ValidatedReceiptEntry = Omit<ReceiptEntry, "outcomes"> & { readonly outcomes: Map<ReceiptTarget, ReceiptStatus> };
type Store = Pick<ReturnType<typeof createCheckinScheduleStore>, "update" | "withExecutionLock">;

function digest(plan: CheckinSchedulePlan) {
  return hash([parseCheckinSchedulePlan(plan)]);
}

function transferFailure(): never {
  throw new Error("旧版签到回执无法核验，已冻结所涉的自动补跑。");
}

function validateReceipt(transfer: ReceiptTransfer, raw: unknown, startedAt: number): Map<string, ValidatedReceiptEntry> {
  const receipt = raw as Receipt | undefined;
  if (!receipt || receipt.protocol !== transfer.protocol || receipt.version !== transfer.version ||
      receipt.date !== transfer.date || receipt.id !== transfer.id || receipt.planDigest !== transfer.planDigest ||
      !Array.isArray(receipt.entries) || receipt.entries.length !== transfer.entries.length) transferFailure();
  const rows = new Map(receipt.entries.map(row => {
    if (!row || typeof row !== "object") transferFailure();
    return [entryKey(row), row];
  }));
  return new Map(transfer.entries.map(scope => {
    const row = rows.get(entryKey(scope));
    if (!row || row.qq !== scope.qq || row.profileId !== scope.profileId || row.accountKey !== scope.accountKey ||
        row.attempts !== scope.retry.attempts + 1 ||
        !Array.isArray(row.outcomes) || row.outcomes.length !== scope.targets.length) transferFailure();
    const outcomes = new Map(row.outcomes.map((item: ReceiptEntry["outcomes"][number]) => {
      if (!item || !scope.targets.includes(item.target) || !["completed", "unsent", "unknown", "stopped"].includes(item.status)) transferFailure();
      return [item.target, item.status];
    }));
    if (outcomes.size !== scope.targets.length) transferFailure();
    const unsent = [...outcomes.values()].includes("unsent");
    const next = typeof row.nextAt === "string" ? Date.parse(row.nextAt) : NaN;
    if (unsent ? !(next > startedAt && checkinScheduleClock(next).date === transfer.date) : row.nextAt !== undefined) transferFailure();
    return [entryKey(scope), { ...row, outcomes }];
  }));
}

function applyReceipt(entry: Entry, row: ValidatedReceiptEntry,
  ownerOk: boolean, now: number, date: string): Entry {
  const { communityRetry, doneAt: _doneAt, ...previous } = entry;
  if (!communityRetry) transferFailure();
  const pending = ownerOk && checkinScheduleClock(now).date === date;
  const oldWrites: Record<string, CheckinCommunityWriteStatus> = { ...entry.communityWrites };
  const forums = communityRetry.forums.filter(id => {
    const state = row.outcomes.get(`community:${id}`);
    if (state === "completed") oldWrites[id] = "accepted";
    if (state === "unknown") oldWrites[id] = "unconfirmed";
    return pending && state === "unsent";
  });
  const games = (communityRetry.games || []).filter(key => pending && row.outcomes.get(`game:${key}`) === "unsent");
  const unknown = [...row.outcomes.values()].includes("unknown");
  const stopped = [...row.outcomes.values()].includes("stopped") || (!pending && [...row.outcomes.values()].includes("unsent"));
  const otherFailure = Boolean(communityRetry.otherFailure || unknown || stopped);
  const ok = !otherFailure && !forums.length && !games.length;
  const logs = Object.keys(oldWrites).length ? { communityWrites: oldWrites, communityWriteAccount: row.accountKey } : {};
  if (forums.length || games.length) {
    return { ...previous, ...logs, done: false, ok: false, stage: "checkin",
      message: "旧版签到回接后已安排剩余项目补跑。",
      communityRetry: { forums, ...(games.length && { games }), attempts: row.attempts,
        nextAt: row.nextAt!, verifiedUnsent: true, accountKey: row.accountKey, otherFailure } };
  }
  return { ...previous, ...logs, done: true, ok, doneAt: checkinScheduleClock(now).iso,
    stage: unknown ? legacyUnconfirmedStage : "checkin",
    message: unknown ? "旧版签到提交结果待核对。" : ok ? "旧版已完成签到。" : "旧版签到有未完成的项目。" };
}

async function guardedScopes(source: CheckinSchedulePlan, legacy: CheckinSchedulePlan | undefined, startedAt: number, loadAccount: GetAccount) {
  if (legacy && legacy.date !== source.date) throw new Error("新旧签到计划日期不一致。");
  if (checkinScheduleClock(startedAt).date !== source.date) return [];
  const date = source.date;
  const entries: ReceiptTransfer["entries"][number][] = [];
  const earlier = new Map(legacy?.entries.map(item => [entryKey(item), item]));
  for (const entry of source.entries) {
    const retry = entry.communityRetry;
    if (entry.done || entry.runningAt || !retry?.verifiedUnsent ||
        Date.parse(retry.nextAt) > startedAt || checkinScheduleClock(Date.parse(retry.nextAt)).date !== date) continue;
    const previous = earlier.get(entryKey(entry));
    if (previous && (previous.done || hasProgress(previous))) continue;
    const current = await loadAccount(entry.qq, entry.profileId);
    if (!matchesAccount(entry, retry.accountKey, current) ||
        (entry.communityWriteAccount && !matchesAccount(entry, entry.communityWriteAccount, current))) continue;
    const allowed = current?.checkinTargets;
    const forums = retry.forums.filter(id => canRetryForum(entry.communityWrites, id) && (!allowed || allowed.forums.includes(id)));
    const games = (retry.games || []).filter(key => gameVerifiedUnsent(entry, key) && (!allowed || allowed.games.includes(key)));
    const targets: ReceiptTarget[] = [...forums.map(id => `community:${id}` as const), ...games.map(key => `game:${key}` as const)];
    if (!targets.length) continue;
    const accountKey = identity(entry, current)!.accountKey;
    const otherFailure = Boolean(retry.otherFailure || hasUnresolvedGameWrite(entry) ||
      forums.length !== retry.forums.length || games.length !== (retry.games?.length ?? 0) ||
      Object.values(entry.communityWrites || {}).some(status => ["pending", "unconfirmed", "rejected", "blocked"].includes(status)));
    entries.push({ qq: entry.qq, profileId: entry.profileId, accountKey, targets,
      retry: { ...retry, forums, games, accountKey, otherFailure } });
  }
  return entries;
}

export async function previewGuardedLegacyCheckinTransfer(
  source: CheckinSchedulePlan, legacy: CheckinSchedulePlan | undefined,
  { now = Date.now(), loadAccount }: { readonly now?: number; readonly loadAccount: GetAccount },
) {
  const entries = await guardedScopes(source, legacy, now, loadAccount);
  return {
    profiles: entries.length,
    forums: entries.reduce((count, entry) => count + entry.retry.forums.length, 0),
    games: entries.reduce((count, entry) => count + (entry.retry.games?.length ?? 0), 0),
  };
}

/** The receiver runs inline and may only use the supplied authorization while this callback is open. */
export async function runGuardedLegacyCheckinTransfer(store: Store, date: string, {
  now = Date.now, loadAccount, legacy, runInline,
}: {
  readonly now?: () => number;
  readonly loadAccount: GetAccount;
  readonly legacy?: CheckinSchedulePlan;
  readonly runInline: (transfer: ReceiptTransfer) => Promise<unknown>;
}) {
  return store.withExecutionLock(date, async () => {
    const startedAt = now();
    if (checkinScheduleClock(startedAt).date !== date) throw new Error("签到执行交还仅支持同日计划。");
    const prepared = await store.update(date, async source => {
      if (!source) return { result: undefined };
      const entries = await guardedScopes(source, legacy, startedAt, loadAccount);
      const selected = new Set(entries.map(entryKey));
      if (!entries.length) return { result: undefined };
      const transfer: ReceiptTransfer = { protocol: receiptProtocol, version: guardedCheckinLegacyVersion, date,
        id: randomUUID(), planDigest: digest(source), entries };
      const frozen: CheckinSchedulePlan = { ...source, entries: source.entries.map(entry => selected.has(entryKey(entry))
        ? { ...entry, done: true, ok: false, stage: legacyUnconfirmedStage,
          message: "旧版执行签到期间已冻结新版补跑。" } : entry) };
      return { plan: frozen, result: { transfer, frozenDigest: digest(frozen) } };
    });
    if (!prepared) return 0;
    const { transfer, frozenDigest } = prepared;
    const rows = validateReceipt(transfer, await runInline(structuredClone(transfer)), startedAt);
    const accounts = new Map<string, boolean>();
    for (const scope of transfer.entries) {
      const current = await loadAccount(scope.qq, scope.profileId).catch(() => undefined);
      accounts.set(entryKey(scope), matchesAccount(scope, scope.accountKey, current));
    }
    return store.update(date, current => {
      if (!current || digest(current) !== frozenDigest) transferFailure();
      const returnedAt = now();
      if (returnedAt < startedAt) transferFailure();
      const entries = current.entries.map(entry => {
        const row = rows.get(entryKey(entry));
        if (!row) return entry;
        const scope = transfer.entries.find(item => entryKey(item) === entryKey(entry))!;
        return applyReceipt({ ...entry, communityRetry: scope.retry }, row, accounts.get(entryKey(entry)) === true, returnedAt, date);
      });
      return { plan: { ...current, entries }, result: rows.size };
    });
  });
}
