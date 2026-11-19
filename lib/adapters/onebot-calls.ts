import { decodeChatFileBytes, encodeChatFile, readQqChatFile, type ChatFile, type ChatFileResult } from "../chat-files.ts";
import { notifyReplyDelivery, type GroupMembership, type GroupRequestType, type RecallResult, type ReplyOptions } from "../messages.ts";
import { memberDisplayName, type MemberRosterEntry } from "./onebot-member-display.ts";

type ResponseValue = Record<string, unknown> | undefined;
export interface OneBotAction {
  readonly action: string;
  readonly params: object;
  readonly echo?: string;
}

export type Send = (frame: OneBotAction) => boolean;

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

  async #request(send: Send, action: string, params: object, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new OneBotNotSentError("QQ 协议连接已关闭。");
    signal?.throwIfAborted();
    const echo = crypto.randomUUID();
    const { promise, resolve } = Promise.withResolvers<ResponseValue>();
    const timer = setTimeout(() => resolve(undefined), 5_000);
    const abort = () => resolve(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    this.#requests.set(echo, resolve);
    try {
      if (!send({ action, params, echo })) throw new OneBotNotSentError("QQ 协议连接已关闭。");
      const result = await promise;
      signal?.throwIfAborted();
      if (!result) throw new Error("未收到 QQ 协议端确认。");
      if (result.status === "failed") throw new OneBotRejectedError("QQ 协议端未接受请求。");
      if (result.status !== "ok" || result.retcode !== 0) throw new Error("QQ 协议端返回了未确认的请求结果。");
      return result.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
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

  async getMessage(send: Send, messageId: number) {
    try {
      const result = await this.#request(send, "get_msg", { message_id: messageId });
      if (!this.#closed && isRecord(result)) return result;
    } catch {
      return undefined;
    }
  }

  async replyWithConfirmation(send: Send, params: object): Promise<boolean> {
    try {
      await this.#request(send, "send_msg", params);
      return true;
    } catch {
      return false;
    }
  }

  async sendConfirmed(send: Send, target: { user_id: number } | { group_id: number }, message: unknown) {
    try {
      const result = await this.#request(send, "send_msg", {
        ...target, message, message_type: "group_id" in target ? "group" : "private", auto_escape: true,
      });
      return this.#messageId(result) === undefined ? "unknown" as const : "confirmed" as const;
    } catch (error) {
      return error instanceof OneBotNotSentError || error instanceof OneBotRejectedError ? "rejected" as const : "unknown" as const;
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

  async listGroups(send: Send, signal?: AbortSignal) {
    const groups = await this.#request(send, "get_group_list", {}, signal);
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

  async loginNickname(send: Send, botId: number, signal: AbortSignal) {
    const result = await this.#request(send, "get_login_info", {}, signal);
    if (isRecord(result) && result.user_id === botId) return memberDisplayName(result.nickname);
  }

  async readOwnGroupCard(send: Send, groupId: number, botId: number, signal: AbortSignal) {
    const result = await this.#getGroupMember(send, groupId, botId, signal);
    if (isRecord(result) && result.group_id === groupId && result.user_id === botId && typeof result.card === "string") {
      return result.card;
    }
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

  async listMemberDisplay(send: Send, groupId: number, fresh = false): Promise<readonly MemberRosterEntry[]> {
    if (!isPositiveInteger(groupId)) throw new RangeError("群号无效。");
    const members = await this.#request(send, "get_group_member_list", { group_id: groupId, ...(fresh ? { no_cache: true } : {}) });
    if (!Array.isArray(members) || members.length > 10_000) throw new Error("QQ 协议端返回无效的群成员列表。");
    const seen = new Set<number>();
    return Array.from(members, (member: unknown) => {
      if (!isRecord(member) || !isPositiveInteger(member.user_id) ||
          ((fresh || "group_id" in member) && member.group_id !== groupId) || seen.has(member.user_id)) {
        throw new Error("QQ 协议端返回无效的群成员列表。");
      }
      const id = member.user_id;
      seen.add(id);
      const card = memberDisplayName(member.card);
      const nickname = memberDisplayName(member.nickname);
      return { id, ...(card === undefined ? {} : { card }), ...(nickname === undefined ? {} : { nickname }) };
    });
  }

  async getGroupRole(send: Send, groupId: number, userId: number, verifyIds = false): Promise<GroupMembership["botRole"] | undefined> {
    try {
      const result = await this.#getGroupMember(send, groupId, userId);
      if (!isRecord(result) || (verifyIds && (result.group_id !== groupId || result.user_id !== userId))) return;
      const role = result.role;
      if (role === "member" || role === "admin" || role === "owner") return role;
    } catch {
      return undefined;
    }
  }

  #getGroupMember(send: Send, groupId: number, userId: number, signal?: AbortSignal): Promise<unknown> {
    return this.#request(send, "get_group_member_info", { group_id: groupId, user_id: userId, no_cache: true }, signal);
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

  async sendForward(send: Send, target: { group_id: number } | { user_id: number }, messages: readonly object[]): Promise<boolean> {
    const action = "group_id" in target ? "send_group_forward_msg" : "send_private_forward_msg";
    try {
      return await this.#confirmAction(send, action, { ...target, messages });
    } catch (error) {
      if (error instanceof OneBotNotSentError) return false;
      throw error;
    }
  }

  async sendForwardConfirmed(send: Send, target: { group_id: number } | { user_id: number }, messages: readonly object[]): Promise<ChatFileResult> {
    const action = "group_id" in target ? "send_group_forward_msg" : "send_private_forward_msg";
    try {
      const result = await this.#request(send, action, { ...target, messages });
      return this.#messageId(result) !== undefined || (isRecord(result) && typeof result.forward_id === "string" && result.forward_id.trim())
        ? "confirmed" : "unknown";
    } catch (error) {
      return error instanceof OneBotNotSentError || error instanceof OneBotRejectedError ? "rejected" : "unknown";
    }
  }

  async uploadFile(send: Send, target: { group_id: number } | { user_id: number }, file: ChatFile): Promise<ChatFileResult> {
    const uri = encodeChatFile(file);
    if (uri === undefined) return "rejected";
    return this.uploadFileUri(send, target, uri, file.name);
  }

  async uploadFileUri(send: Send, target: { group_id: number } | { user_id: number }, uri: string, name: string): Promise<ChatFileResult> {
    const action = "group_id" in target ? "upload_group_file" : "upload_private_file";
    try {
      const result = await this.#request(send, action, { ...target, file: uri, name });
      return isRecord(result) && typeof result.file_id === "string" && result.file_id.trim()
        ? "confirmed" : "unknown";
    } catch (error) {
      return error instanceof OneBotRejectedError || error instanceof OneBotNotSentError ? "rejected" : "unknown";
    }
  }

  async readFile(send: Send, target: { group_id: number; busid?: number } | { user_id: number },
    fileId: string, name: string, size?: number, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    try {
      const group = "group_id" in target;
      const action = group ? "get_group_file_url" : "get_private_file_url";
      const data = await this.#request(send, action, group ? { ...target, file_id: fileId } : { file_id: fileId }, signal);
      if (isRecord(data)) {
        const bytes = await readQqChatFile(data.url, size, signal);
        if (bytes) return bytes;
      }
    } catch {
      // Some NapCat configurations provide bytes through get_file only.
    }
    try {
      const data = await this.#request(send, "get_file", { file: fileId }, signal);
      if (isRecord(data) && (data.file_name === undefined || data.file_name === "" || data.file_name === name)) {
        return decodeChatFileBytes(data.base64, size);
      }
    } catch {
      return undefined;
    }
  }

  async recallMessage(send: Send, messageId: number): Promise<RecallResult> {
    try {
      await this.deleteMessage(send, messageId);
      return "confirmed";
    } catch (error) {
      return error instanceof OneBotRejectedError || error instanceof OneBotNotSentError ? "rejected" : "unknown";
    }
  }

  async setGroupCard(send: Send, group_id: number, user_id: number, card: string, signal?: AbortSignal): Promise<RecallResult> {
    try {
      await this.#request(send, "set_group_card", { group_id, user_id, card }, signal);
      return "confirmed";
    } catch (error) {
      return error instanceof OneBotRejectedError || error instanceof OneBotNotSentError ? "rejected" : "unknown";
    }
  }

  #messageId(result: unknown): number | undefined {
    const id = typeof result === "object" && result !== null && "message_id" in result
      ? result.message_id : undefined;
    return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
  }

  async replyWithReceipt(send: Send, params: object, seconds?: number, original?: number,
    onDelivered?: ReplyOptions["onDelivered"]): Promise<boolean> {
    let result: unknown;
    try {
      result = await this.#request(send, "send_msg", params);
    } catch {
      return false;
    }
    const id = this.#messageId(result);
    if (this.#closed || id === undefined) return true;

    if (seconds !== undefined) this.#scheduleRecall(send, id, seconds, original);
    await notifyReplyDelivery(onDelivered, id);
    return true;
  }

  #scheduleRecall(send: Send, id: number, seconds: number, original?: number): void {
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
