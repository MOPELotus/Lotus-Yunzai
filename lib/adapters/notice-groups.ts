import type { MessageReply } from "../messages.ts";
import type { GroupTarget, GroupTransport } from "./onebot-groups.ts";

export class NoticeNotSentError extends Error {
  readonly delivery = "not-sent";
}

export interface NoticeGroupAccount {
  readonly botId: number;
  readonly adapter: "onebot" | "milky";
  listGroups(signal?: AbortSignal): Promise<readonly GroupTarget[]>;
  sendGroup(groupId: number, message: MessageReply, signal?: AbortSignal): Promise<number>;
  recall(groupId: number, messageId: number, signal?: AbortSignal): Promise<void>;
}

export interface NoticeGroupTransport extends GroupTransport {
  noticeAccounts(): readonly NoticeGroupAccount[];
  recallGroupMessage(adapter: NoticeGroupAccount["adapter"], botId: number, groupId: number, messageId: number,
    signal?: AbortSignal): Promise<void>;
}

export function waitForMilkyNoticeReceipts(shutdown: AbortSignal) {
  const connection = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const closed = Promise.withResolvers<void>();
  const close = () => {
    connection.abort();
    closed.resolve();
  };
  const drain = () => {
    if (!pending.size) { close(); return; }
    const timer = setTimeout(close, 5_000);
    void Promise.allSettled(pending).then(() => {
      clearTimeout(timer);
      close();
    });
  };
  if (shutdown.aborted) close();
  else shutdown.addEventListener("abort", drain, { once: true });
  return {
    signal: connection.signal,
    closed: closed.promise,
    track(attempt: Promise<unknown>) {
      pending.add(attempt);
      const finish = () => pending.delete(attempt);
      void attempt.then(finish, finish);
    },
  };
}

export function noticeGroupTransport(fallback: GroupTransport, onebot: () => readonly NoticeGroupAccount[],
  milky: () => NoticeGroupAccount | undefined): NoticeGroupTransport {
  return Object.freeze({
    ...fallback,
    noticeAccounts() {
      const accounts = onebot();
      const other = milky();
      if (!other || accounts.some(account => account.botId === other.botId)) return accounts;
      return [...accounts, other].sort((left, right) => left.botId - right.botId);
    },
    async recallGroupMessage(adapter: NoticeGroupAccount["adapter"], botId: number, groupId: number,
      messageId: number, signal?: AbortSignal) {
      const account = adapter === "onebot" ? onebot().find(account => account.botId === botId) : milky();
      if (account?.botId !== botId || signal?.aborted) throw new NoticeNotSentError("原公告会话不可用。");
      await account.recall(groupId, messageId, signal);
    },
  });
}
