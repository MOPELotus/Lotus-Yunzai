import type { GroupMembership, GroupRequestType } from "../messages.ts";

type ResponseValue = Record<string, unknown> | undefined;
type Send = (message: string) => boolean;

export class OneBotNotSentError extends Error {
  readonly delivery = "not-sent";
}
class OneBotRejectedError extends Error {}

export function isRequestFlag(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export class OneBotCalls {
  readonly #requests = new Map<string, (response: ResponseValue) => void>();
  readonly #recalls = new Set<ReturnType<typeof setTimeout>>();
  #closed = false;

  async #request(send: Send, action: string, params: object): Promise<unknown> {
    if (this.#closed) throw new OneBotNotSentError("QQ 协议连接已关闭。");
    const echo = crypto.randomUUID();
    const { promise, resolve } = Promise.withResolvers<ResponseValue>();
    const timer = setTimeout(() => resolve(undefined), 5_000);
    this.#requests.set(echo, resolve);
    try {
      if (!send(JSON.stringify({ action, params, echo }))) throw new OneBotNotSentError("QQ 协议连接已关闭。");
      const result = await promise;
      if (!result) throw new Error("未收到 QQ 协议端确认。");
      if (result.status === "failed") throw new OneBotRejectedError("QQ 协议端未接受请求。");
      if (result.status !== "ok" || result.retcode !== 0) throw new Error("QQ 协议端返回了未确认的请求结果。");
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

  async replyWithConfirmation(send: Send, params: object): Promise<boolean> {
    try {
      await this.#request(send, "send_msg", params);
      return true;
    } catch {
      return false;
    }
  }

  async reviewGroupRequest(send: Send, flag: string, sub_type: GroupRequestType, approve: boolean, reason = ""): Promise<boolean> {
    if (!isRequestFlag(flag) || (sub_type !== "add" && sub_type !== "invite") ||
        typeof approve !== "boolean" || typeof reason !== "string" || reason.length > 512) return false;
    return this.#confirmAction(send, "set_group_add_request", { flag, sub_type, approve, reason: approve ? "" : reason });
  }

  async reviewFriendRequest(send: Send, flag: string, approve: boolean, remark = ""): Promise<boolean> {
    if (!isRequestFlag(flag) || typeof approve !== "boolean" || typeof remark !== "string" || remark.length > 512) {
      return false;
    }
    return this.#confirmAction(send, "set_friend_add_request", { flag, approve, remark: approve ? remark : "" });
  }

  async #confirmAction(send: Send, action: string, params: object): Promise<boolean> {
    try {
      await this.#request(send, action, params);
      return true;
    } catch (error) {
      if (error instanceof OneBotRejectedError) return false;
      throw error;
    }
  }

  async listGroups(send: Send) {
    const groups = await this.#request(send, "get_group_list", {});
    if (!Array.isArray(groups)) throw new Error("QQ 协议端未返回群列表。");
    return groups.map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null || !("group_id" in entry) ||
          typeof entry.group_id !== "number" || !Number.isSafeInteger(entry.group_id) || entry.group_id < 1) {
        throw new Error("QQ 协议端返回无效的群列表。");
      }
      const name = "group_name" in entry && typeof entry.group_name === "string" ? entry.group_name : undefined;
      return { id: entry.group_id, name };
    });
  }

  async getGroupName(send: Send, groupId: number): Promise<string | undefined> {
    try {
      const group = await this.#request(send, "get_group_info", { group_id: groupId });
      if (typeof group !== "object" || group === null || !("group_name" in group) ||
          typeof group.group_name !== "string") return;
      return group.group_name;
    } catch {
      return undefined;
    }
  }

  async getGroupRole(send: Send, groupId: number, userId: number): Promise<"member" | "admin" | "owner" | undefined> {
    try {
      const result = await this.#getGroupMember(send, groupId, userId);
      const role = isRecord(result) ? result.role : undefined;
      if (role === "member" || role === "admin" || role === "owner") return role;
    } catch {
      return undefined;
    }
  }

  #getGroupMember(send: Send, groupId: number, userId: number): Promise<unknown> {
    return this.#request(send, "get_group_member_info", { group_id: groupId, user_id: userId, no_cache: true });
  }

  async #getGroupSize(send: Send, groupId: number): Promise<number | undefined> {
    const result = await this.#request(send, "get_group_info", { group_id: groupId, no_cache: true });
    if (isRecord(result) && result.group_id === groupId && isPositiveInteger(result.member_count)) return result.member_count;
  }

  async inspectAutoQuit(send: Send, groupId: number, userId: number, joinedAt: number,
    maxMembers: number): Promise<GroupMembership | undefined> {
    try {
      const count = await this.#getGroupSize(send, groupId);
      if (count === undefined || count > maxMembers) return;
      const members = await this.#request(send, "get_group_member_list", { group_id: groupId });
      if (!Array.isArray(members) || members.length !== count) return;
      const memberIds = new Set<number>();
      let listedRole: unknown;
      for (const member of members) {
        if (!isRecord(member) || member.group_id !== groupId || !isPositiveInteger(member.user_id) || memberIds.has(member.user_id)) return;
        memberIds.add(member.user_id);
        if (member.user_id === userId) listedRole = member.role;
      }
      if (!memberIds.has(userId)) return;
      const bot = await this.#getGroupMember(send, groupId, userId);
      if (!isRecord(bot) || bot.group_id !== groupId || bot.user_id !== userId || bot.role !== listedRole) return;
      if (bot.role !== "admin" && bot.role !== "member") return;
      if (isPositiveInteger(bot.join_time) && bot.join_time > joinedAt) return;
      if (await this.#getGroupSize(send, groupId) !== count) return;
      return { memberIds: [...memberIds], botRole: bot.role };
    } catch {
      return undefined;
    }
  }

  leaveGroup(send: Send, groupId: number): Promise<boolean> {
    return this.#confirmAction(send, "set_group_leave", { group_id: groupId, is_dismiss: false });
  }

  async sendGroup(send: Send, groupId: number, message: unknown): Promise<number> {
    const result = await this.#request(send, "send_msg", {
      message_type: "group", group_id: groupId, message, auto_escape: true,
    });
    const id = this.#messageId(result);
    if (id === undefined) throw new Error("QQ 协议端未返回发送消息的编号。");
    return id;
  }

  async deleteMessage(send: Send, messageId: number): Promise<void> {
    await this.#request(send, "delete_msg", { message_id: messageId });
  }

  #messageId(result: unknown): number | undefined {
    const id = typeof result === "object" && result !== null && "message_id" in result
      ? result.message_id : undefined;
    return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
  }

  async replyWithRecall(send: Send, params: object, seconds: number, original?: number): Promise<boolean> {
    let result: unknown;
    try {
      result = await this.#request(send, "send_msg", params);
    } catch {
      return false;
    }
    const id = this.#messageId(result);
    if (this.#closed || id === undefined) return true;

    const timer = setTimeout(() => {
      this.#recalls.delete(timer);
      const messages = new Set(original === undefined ? [id] : [id, original]);
      for (const messageId of messages) {
        void this.deleteMessage(send, messageId).catch(() => {
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
