type ResponseValue = Record<string, unknown> | undefined;
type Send = (message: string) => boolean;

export class OneBotCalls {
  readonly #requests = new Map<string, (response: ResponseValue) => void>();
  readonly #recalls = new Set<ReturnType<typeof setTimeout>>();
  #closed = false;

  async #request(send: Send, action: string, params: object): Promise<unknown> {
    if (this.#closed) throw new Error("QQ 协议连接已关闭。");
    const echo = crypto.randomUUID();
    const { promise, resolve } = Promise.withResolvers<ResponseValue>();
    const timer = setTimeout(() => resolve(undefined), 5_000);
    this.#requests.set(echo, resolve);
    try {
      if (!send(JSON.stringify({ action, params, echo }))) throw new Error("QQ 协议连接已关闭。");
      const result = await promise;
      if (!result) throw new Error("未收到 QQ 协议端确认。");
      if (result.status !== "ok" || result.retcode !== 0) throw new Error("QQ 协议端未接受请求。");
      return result.data;
    } finally {
      clearTimeout(timer);
      this.#requests.delete(echo);
    }
  }

  async likeSelf(send: Send, userId: number, count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new RangeError("单次点赞次数须为 1 至 10。");
    }
    await this.#request(send, "send_like", { user_id: userId, times: count });
    return count;
  }

  async isFriend(send: Send, userId: number): Promise<boolean> {
    const friends = await this.#request(send, "get_friend_list", {});
    if (!Array.isArray(friends)) throw new Error("QQ 协议端未返回好友列表。");
    return friends.some((friend: unknown) =>
      typeof friend === "object" && friend !== null && "user_id" in friend && String(friend.user_id) === String(userId));
  }

  async replyWithRecall(send: Send, params: object, seconds: number, original?: number): Promise<boolean> {
    let result: unknown;
    try {
      result = await this.#request(send, "send_msg", params);
    } catch {
      return false;
    }
    const id = typeof result === "object" && result !== null && "message_id" in result
      ? result.message_id : undefined;
    if (this.#closed || typeof id !== "number" || !Number.isSafeInteger(id)) return true;

    const timer = setTimeout(() => {
      this.#recalls.delete(timer);
      const messages = new Set(original === undefined ? [id] : [id, original]);
      for (const message_id of messages) {
        void this.#request(send, "delete_msg", { message_id }).catch(() => {
          if (!this.#closed) console.warn("OneBot 消息撤回未获确认。");
        });
      }
    }, seconds * 1_000);
    timer.unref();
    this.#recalls.add(timer);
    return true;
  }

  receive(message: Record<string, unknown>): boolean {
    if (typeof message.echo !== "string" || typeof message.status !== "string") return false;
    this.#requests.get(message.echo)?.(message);
    return true;
  }

  close(): void {
    this.#closed = true;
    for (const timer of this.#recalls) clearTimeout(timer);
    this.#recalls.clear();
    for (const finish of this.#requests.values()) finish(undefined);
    this.#requests.clear();
  }
}
