import type { MessageReply } from "../messages.ts";
import { OneBotNotSentError, type OneBotCalls } from "./onebot-calls.ts";
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
  readonly send: (message: string) => boolean;
}

export class OneBotGroups implements GroupTransport {
  readonly #connected = new Map<number, Connection>();

  connect(botId: number, connection: Connection): () => void {
    this.#connected.set(botId, connection);
    return () => {
      if (this.#connected.get(botId) === connection) this.#connected.delete(botId);
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

  async deleteMessage(botId: number, messageId: number): Promise<void> {
    if (!Number.isSafeInteger(messageId)) throw new OneBotNotSentError("消息编号无效。");
    const { calls, send } = this.#connection(botId);
    await calls.deleteMessage(send, messageId);
  }

  #connection(botId: number): Connection {
    const connection = this.#connected.get(botId);
    if (!connection) throw new OneBotNotSentError("指定机器人未连接 OneBot。");
    return connection;
  }
}
