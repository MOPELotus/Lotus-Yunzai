import type { MessageReply } from "../messages.ts";
import type { BotNotifications } from "../checkin-notify.ts";
import { OneBotNotSentError, type OneBotCalls, type Send } from "./onebot-calls.ts";
import { encodeOneBotReply } from "./onebot-message.ts";

export interface GroupTarget {
  readonly id: number;
  readonly name?: string;
}

export interface GroupTransport {
  onlineBots(): readonly number[];
  listGroups(botId: number): Promise<readonly GroupTarget[]>;
  sendGroup(botId: number, groupId: number, content: MessageReply): Promise<number>;
  deleteMessage(botId: number, messageId: number): Promise<void>;
}

interface Connection {
  readonly calls: OneBotCalls;
  readonly send: Send;
  readonly retireMemberDisplay?: () => void;
}

interface ConnectedAccount {
  readonly connection: Connection;
  readonly startedAt: number;
}

export class OneBotGroups implements GroupTransport {
  readonly #connected = new Map<number, ConnectedAccount>();
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  connect(botId: number, connection: Connection): () => void {
    const account = { connection, startedAt: this.#now() };
    const previous = this.#connected.get(botId);
    this.#connected.set(botId, account);
    previous?.connection.retireMemberDisplay?.();
    return () => {
      if (this.#connected.get(botId) === account) this.#connected.delete(botId);
    };
  }

  transport(): GroupTransport {
    return Object.freeze({
      onlineBots: () => this.onlineBots(),
      listGroups: (botId: number) => this.listGroups(botId),
      sendGroup: (botId: number, groupId: number, content: MessageReply) => this.sendGroup(botId, groupId, content),
      deleteMessage: (botId: number, messageId: number) => this.deleteMessage(botId, messageId),
    });
  }

  onlineBots(): readonly number[] {
    return [...this.#connected.keys()].sort((left, right) => left - right);
  }

  onlineAccounts(): readonly { readonly id: number; readonly seconds: number }[] {
    const now = this.#now();
    return [...this.#connected].sort(([left], [right]) => left - right).map(([id, account]) => ({
      id,
      seconds: Math.max(0, Math.floor((now - account.startedAt) / 1_000)),
    }));
  }

  checkinNotifications(): readonly BotNotifications[] {
    return this.onlineBots().flatMap(botId => {
      const account = this.#connected.get(botId);
      if (!account) return [];
      const { calls, send } = account.connection;
      const active = () => this.#connected.get(botId) === account;
      const deliver = async (target: { user_id: number } | { group_id: number }, reply: MessageReply) => {
        const message = encodeOneBotReply(reply);
        if (!active() || message === undefined) return "rejected" as const;
        return calls.sendConfirmed(send, target, message);
      };
      return [{
        botId,
        isFriend: async (userId: number) => active() && await calls.isFriend(send, userId) && active(),
        isGroupMember: async (groupId: number, userId: number) =>
          active() && await calls.getGroupRole(send, groupId, userId, true) !== undefined && active(),
        sendPrivate: (userId: number, reply: MessageReply) => deliver({ user_id: userId }, reply),
        sendGroup: (groupId: number, reply: MessageReply) => deliver({ group_id: groupId }, reply),
      }];
    });
  }

  async listGroups(botId: number): Promise<readonly GroupTarget[]> {
    const { calls, send } = this.#connection(botId);
    return calls.listGroups(send);
  }

  async sendGroup(botId: number, groupId: number, content: MessageReply): Promise<number> {
    const message = encodeOneBotReply(content);
    if (message === undefined || !Number.isSafeInteger(groupId) || groupId < 1) {
      throw new OneBotNotSentError("群号或待发送消息无效。");
    }
    const { calls, send } = this.#connection(botId);
    return calls.sendGroup(send, groupId, message);
  }

  async sendPrivate(botId: number, userId: number, content: MessageReply): Promise<boolean> {
    const message = encodeOneBotReply(content);
    if (message === undefined || !Number.isSafeInteger(userId) || userId < 1) {
      throw new OneBotNotSentError("用户 QQ 或待发送消息无效。");
    }
    const { calls, send } = this.#connection(botId);
    return calls.replyWithConfirmation(send, { message_type: "private", user_id: userId, message, auto_escape: true });
  }

  async deleteMessage(botId: number, messageId: number): Promise<void> {
    if (!Number.isSafeInteger(messageId)) throw new OneBotNotSentError("消息编号无效。");
    const { calls, send } = this.#connection(botId);
    await calls.deleteMessage(send, messageId);
  }

  #connection(botId: number): Connection {
    const account = this.#connected.get(botId);
    if (!account) throw new OneBotNotSentError("指定机器人未连接 OneBot。");
    return account.connection;
  }
}
