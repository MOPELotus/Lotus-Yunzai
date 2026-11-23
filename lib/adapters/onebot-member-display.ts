export const legacyGroupMemberRoster = Symbol("legacyGroupMemberRoster");

export interface MemberDisplay {
  readonly card?: string;
  readonly nickname?: string;
}

export interface MemberRosterEntry extends MemberDisplay {
  readonly id: number;
}

interface Warmup {
  readonly touched: Map<number, ObservedFields | "removed">;
  readonly promise: Promise<void>;
  discard: boolean;
}

interface ObservedFields {
  readonly card: boolean;
  readonly nickname: boolean;
}

interface GroupDisplay {
  readonly members: Map<number, MemberDisplay>;
  warmup?: Warmup;
}

const maxGroups = 128;
const maxMembers = 20_000;
const maxWarmups = 16;
const maxWarmupChanges = 1_024;
const maxNameLength = 256;

function isId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function memberDisplayName(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || value.length > maxNameLength ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return;
  const name = value.trim();
  if (name || allowEmpty) return name;
}

function display(card?: string, nickname?: string): MemberDisplay {
  return Object.freeze({ ...(card === undefined ? {} : { card }), ...(nickname === undefined ? {} : { nickname }) });
}

export class OneBotMemberDisplay {
  readonly #groups = new Map<number, GroupDisplay>();
  #memberCount = 0;
  #warmupCount = 0;
  #closed = false;

  constructor(private readonly load: (groupId: number) => Promise<readonly MemberRosterEntry[]>) {}

  get closed(): boolean {
    return this.#closed;
  }

  warm(groupId: number): Promise<void> {
    if (this.#closed || !isId(groupId)) return Promise.resolve();
    const pending = this.#groups.get(groupId)?.warmup;
    if (pending) return pending.promise;
    if (this.#warmupCount >= maxWarmups) return Promise.resolve();

    const group = this.#group(groupId);
    const warmup: Warmup = {
      touched: new Map(), discard: false,
      promise: Promise.resolve()
        .then(() => this.#groups.get(groupId) === group ? this.load(groupId) : [])
        .then((rows) => this.#merge(groupId, group, warmup, rows))
        .catch(() => {})
        .finally(() => {
          this.#warmupCount--;
          group.warmup = undefined;
        }),
    };
    this.#warmupCount++;
    group.warmup = warmup;
    return warmup.promise;
  }

  remember(groupId: number, userId: number, member: MemberDisplay): void {
    if (this.#closed || !isId(groupId) || !isId(userId)) return;
    const card = memberDisplayName(member.card, true);
    const nickname = memberDisplayName(member.nickname, true);
    if (card === undefined && nickname === undefined) return;

    const group = this.#group(groupId);
    const observed = group.warmup?.touched.get(userId);
    this.#touchDuringWarmup(group, userId, {
      card: card !== undefined || observed === "removed" || observed?.card === true,
      nickname: nickname !== undefined || observed === "removed" || observed?.nickname === true,
    });
    const previous = group.members.get(userId);
    this.#put(group, userId, display(card ?? previous?.card, nickname ?? previous?.nickname));
  }

  peek(groupId: number, userId: number): MemberDisplay | undefined {
    const group = this.#groups.get(groupId);
    const member = group?.members.get(userId);
    if (group && member) {
      this.#touchGroup(groupId, group);
      group.members.delete(userId);
      group.members.set(userId, member);
    }
    return member;
  }

  remove(groupId: number, userId: number): void {
    const group = this.#groups.get(groupId);
    if (!group || !isId(userId)) return;
    this.#touchDuringWarmup(group, userId, "removed");
    if (group.members.delete(userId)) this.#memberCount--;
  }

  forget(groupId: number): void {
    const group = this.#groups.get(groupId);
    if (!group) return;
    this.#groups.delete(groupId);
    this.#memberCount -= group.members.size;
    group.members.clear();
    group.warmup?.touched.clear();
  }

  close(): void {
    this.#closed = true;
    for (const groupId of this.#groups.keys()) this.forget(groupId);
  }

  #group(groupId: number): GroupDisplay {
    const existing = this.#groups.get(groupId);
    if (existing) {
      this.#touchGroup(groupId, existing);
      return existing;
    }

    if (this.#groups.size >= maxGroups) {
      const oldest = this.#groups.keys().next();
      if (!oldest.done) this.forget(oldest.value);
    }
    const group: GroupDisplay = { members: new Map() };
    this.#groups.set(groupId, group);
    return group;
  }

  #touchGroup(groupId: number, group: GroupDisplay): void {
    this.#groups.delete(groupId);
    this.#groups.set(groupId, group);
  }

  #touchDuringWarmup(group: GroupDisplay, userId: number, observed: ObservedFields | "removed"): void {
    const warmup = group.warmup;
    if (!warmup || warmup.discard) return;
    warmup.touched.set(userId, observed);
    if (warmup.touched.size > maxWarmupChanges) {
      // Under heavy churn, discard the snapshot instead of dropping removals from the change set.
      warmup.discard = true;
      warmup.touched.clear();
    }
  }

  #merge(groupId: number, group: GroupDisplay, warmup: Warmup, rows: readonly MemberRosterEntry[]): void {
    if (this.#groups.get(groupId) !== group || warmup.discard) return;
    this.#touchGroup(groupId, group);
    const roster = new Map<number, MemberDisplay>();
    for (const { id, card, nickname } of rows.slice(0, maxMembers)) {
      if (!isId(id)) continue;
      const observed = warmup.touched.get(id);
      if (observed === "removed") continue;
      const latest = group.members.get(id);
      const displayCard = observed?.card ? latest?.card : memberDisplayName(card);
      const displayNickname = observed?.nickname ? latest?.nickname : memberDisplayName(nickname);
      if (displayCard !== undefined || displayNickname !== undefined) roster.set(id, display(displayCard, displayNickname));
    }

    for (const userId of group.members.keys()) {
      if (!roster.has(userId) && !warmup.touched.has(userId)) {
        group.members.delete(userId);
        this.#memberCount--;
      }
    }
    for (const [userId, member] of roster) {
      if (!group.members.has(userId) && group.members.size >= maxMembers) continue;
      this.#put(group, userId, member);
    }
  }

  #put(group: GroupDisplay, userId: number, member: MemberDisplay): void {
    if (!group.members.delete(userId)) this.#memberCount++;
    group.members.set(userId, member);
    if (this.#memberCount <= maxMembers) return;

    for (const candidate of this.#groups.values()) {
      const oldest = candidate.members.keys().next();
      if (oldest.done) continue;
      candidate.members.delete(oldest.value);
      this.#memberCount--;
      return;
    }
  }
}
