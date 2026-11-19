import type { RecallResult } from "../messages.ts";

export const ownGroupCardSession = Symbol("当前机器人自身群名片会话");

export interface OwnGroupCardAccount {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly nickname?: string;
  readonly signal: AbortSignal;
  groups(): Promise<readonly number[] | undefined>;
  updateSelfCard(groupId: number, card: string, signal?: AbortSignal): Promise<RecallResult | "unchanged">;
}

interface CardTransport {
  readonly adapter: OwnGroupCardAccount["adapter"];
  readonly botId: number;
  readonly signal: AbortSignal;
  readonly nickname?: string;
  loginNickname?(): Promise<string | undefined>;
  groups(): Promise<readonly number[] | undefined>;
  read(groupId: number): Promise<string | undefined>;
  write(groupId: number, card: string): Promise<RecallResult>;
}

export function bindOwnGroupCard(transport: CardTransport, authorized: () => boolean = () => true): OwnGroupCardAccount {
  const { adapter, botId, signal } = transport;
  const active = () => !signal.aborted && authorized();
  let nickname = transport.nickname;
  let listedGroups: Set<number> | undefined;
  return Object.freeze({
    adapter, botId, signal,
    get nickname() { return nickname; },
    async groups() {
      listedGroups = undefined;
      if (!active()) return;
      const groups = await transport.groups().catch(() => undefined);
      if (!active() || !groups || groups.length > 10_000 || groups.some(id => !Number.isSafeInteger(id) || id < 1)) return;
      const unique = new Set(groups);
      if (unique.size !== groups.length) return;
      nickname ??= await transport.loginNickname?.().catch(() => undefined);
      if (!active()) return;
      listedGroups = unique;
      return [...unique];
    },
    async updateSelfCard(groupId: number, card: string, jobSignal?: AbortSignal) {
      const roster = listedGroups;
      const canWrite = () => active() && !jobSignal?.aborted && roster === listedGroups && roster?.has(groupId);
      if (!canWrite() || typeof card !== "string" || !card.isWellFormed() || !card.trim() ||
          /[\p{Cc}\p{Cf}]/u.test(card)) return "rejected";
      const current = await transport.read(groupId).catch(() => undefined);
      if (!canWrite() || current === undefined) return "rejected";
      if (current === card) return "unchanged";
      return transport.write(groupId, card).catch(() => "unknown" as const);
    },
  });
}
