import { decodeChatFileBytes, encodeChatFile, readQqChatFile, type ChatFile, type ChatFileResult } from "../chat-files.ts";
import { notifyReplyDelivery, type GroupMembership, type GroupRequestType, type RecallResult, type ReplyOptions } from "../messages.ts";
import { memberDisplayName, type MemberRosterEntry } from "./onebot-member-display.ts";
import { readGroupActivity, readGroupAnnouncements, type GroupActivityVisibility, type GroupModerationResult, type LiveGroupMember, type MutedGroupMember } from "./group-moderation.ts";
import type { JoinRequestOrigin, PendingGroupJoinEntry, PendingGroupJoinList } from "../group-join-review.ts";
import type { PendingGroupInvitation, PendingGroupInvitationList } from "../group-invitations.ts";
import type { PendingFriendRequest, PendingFriendRequestList } from "../friend-requests.ts";

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
  readonly #friendRequests = new Map<string, { entry: PendingFriendRequest; expires: number; reviewing: number; settled: boolean }>();
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

  async likeSelf(send: Send, userId: number, count: number, signal?: AbortSignal): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new RangeError("单次点赞次数须为 1 至 10。");
    }
    try {
      await this.#request(send, "send_like", { user_id: userId, times: count }, signal);
      return count;
    } catch (error) {
      if (error instanceof OneBotRejectedError) return 0;
      throw error;
    }
  }

  async readFriendProfiles(send: Send, signal?: AbortSignal): Promise<readonly unknown[]> {
    const friends = await this.#request(send, "get_friend_list", {}, signal);
    if (!Array.isArray(friends)) throw new Error("QQ 协议端未返回好友列表。");
    return friends;
  }

  async listFriendProfiles(send: Send, signal?: AbortSignal) {
    return (await this.readFriendProfiles(send, signal)).filter(isRecord);
  }

  async isFriend(send: Send, userId: number, signal?: AbortSignal): Promise<boolean> {
    return (await this.listFriendProfiles(send, signal)).some(friend => String(friend.user_id) === String(userId));
  }

  async friendship(send: Send, userId: number, signal?: AbortSignal) {
    const friends = await this.#request(send, "get_friend_list", {}, signal);
    if (!Array.isArray(friends) || friends.some(friend => {
      if (!isRecord(friend)) return true;
      const id = friend.user_id;
      return (typeof id !== "number" && typeof id !== "string") ||
        !/^[1-9]\d*$/u.test(String(id)) || !Number.isSafeInteger(Number(id));
    })) return;
    return friends.some(friend => Number(friend.user_id) === userId);
  }

  async getMessage(send: Send, messageId: number, signal?: AbortSignal) {
    try {
      const result = await this.#request(send, "get_msg", { message_id: messageId }, signal);
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

  async sendConfirmed(send: Send, target: { user_id: number } | { group_id: number }, message: unknown, signal?: AbortSignal,
    onDelivered?: ReplyOptions["onDelivered"]) {
    try {
      const result = await this.#request(send, "send_msg", {
        ...target, message, message_type: "group_id" in target ? "group" : "private", auto_escape: true,
      }, signal);
      const id = this.#messageId(result);
      if (id === undefined) return "unknown" as const;
      await notifyReplyDelivery(onDelivered, id);
      return "confirmed" as const;
    } catch (error) {
      return error instanceof OneBotNotSentError || error instanceof OneBotRejectedError ? "rejected" as const : "unknown" as const;
    }
  }

  async readPrivateHistoryMessage(send: Send, owner: number, messageId: number, signal: AbortSignal) {
    try {
      const result = await this.#request(send, "get_friend_msg_history", { user_id: owner, message_seq: messageId,
        count: 10, disable_get_url: true, parse_mult_msg: false }, signal);
      if (!isRecord(result) || !Array.isArray(result.messages)) return;
      const matches = result.messages.filter(row => isRecord(row) && row.message_id === messageId);
      if (matches.length === 1 && isRecord(matches[0])) return matches[0];
    } catch { return; }
  }

  async reviewGroupRequest(send: Send, flag: string, sub_type: GroupRequestType, approve: boolean, reason = ""): Promise<boolean> {
    if (!isRequestFlag(flag) || (sub_type !== "add" && sub_type !== "invite") ||
        typeof approve !== "boolean" || typeof reason !== "string" || reason.length > 512) return false;
    return this.#confirmAction(send, "set_group_add_request", { flag, sub_type, approve, reason: approve ? "" : reason });
  }

  #moderateGroup(send: Send, action: string, params: object, signal: AbortSignal): Promise<GroupModerationResult> {
    if (signal.aborted) return Promise.resolve("rejected");
    return this.#request(send, action, params, signal).then(
      () => "confirmed",
      error => error instanceof OneBotNotSentError || error instanceof OneBotRejectedError ? "rejected" : "unknown",
    );
  }

  kickGroupMember(send: Send, group_id: number, user_id: number, signal: AbortSignal, reject_add_request = false) {
    return this.#moderateGroup(send, "set_group_kick", { group_id, user_id, reject_add_request }, signal);
  }

  setGroupMute(send: Send, group_id: number, user_id: number, duration: number, signal: AbortSignal) {
    return this.#moderateGroup(send, "set_group_ban", { group_id, user_id, duration }, signal);
  }

  setGroupWholeMute(send: Send, group_id: number, enable: boolean, signal: AbortSignal) {
    return this.#moderateGroup(send, "set_group_whole_ban", { group_id, enable }, signal);
  }

  setGroupSpecialTitle(send: Send, group_id: number, user_id: number, special_title: string, signal: AbortSignal) {
    return this.#moderateGroup(send, "set_group_special_title", { group_id, user_id, special_title }, signal);
  }

  setGroupAdmin(send: Send, group_id: number, user_id: number, enable: boolean, signal: AbortSignal) {
    return this.#moderateGroup(send, "set_group_admin", { group_id, user_id, enable }, signal);
  }

  setGroupName(send: Send, group_id: number, group_name: string, signal: AbortSignal) {
    return this.#moderateGroup(send, "set_group_name", { group_id, group_name }, signal);
  }

  setQuotedEssence(send: Send, message_id: number, enabled: boolean, signal: AbortSignal) {
    return this.#moderateGroup(send, enabled ? "set_essence_msg" : "delete_essence_msg", { message_id }, signal);
  }

  declineGroupApplication(send: Send, flag: string, signal: AbortSignal, reason: string) {
    return this.#moderateGroup(send, "set_group_add_request", {
      flag, sub_type: "add", approve: false, reason,
    }, signal);
  }

  async verifyPendingGroupJoin(send: Send, origin: Extract<JoinRequestOrigin, { adapter: "onebot" }>, signal: AbortSignal) {
    try {
      if (!await this.isNapCat(send, signal) || signal.aborted) return "unavailable" as const;
      const choose = (rows: unknown) => Array.isArray(rows) ? rows.filter((item: unknown): item is Record<string, unknown> =>
        isRecord(item) && item.group_id === origin.groupId && item.invitor_uin === origin.userId &&
        isPositiveInteger(item.request_id) && String(item.request_id) === origin.flag) : undefined;
      const list = await this.#request(send, "get_group_system_msg", { count: 100 }, signal);
      const ordinary = isRecord(list) ? choose(list.join_requests) : undefined;
      if (signal.aborted || !ordinary || ordinary.length > 1) return "unavailable" as const;
      if (ordinary.length === 1) {
        if (ordinary[0]?.checked === false) return "pending" as const;
        return ordinary[0]?.checked === true ? "expired" as const : "unavailable" as const;
      }
      const risk = choose(await this.#request(send, "get_group_ignore_add_request", {}, signal));
      return !signal.aborted && risk?.length === 1 && risk[0]?.checked === false ? "risk" as const : "unavailable" as const;
    } catch { return "unavailable" as const; }
  }

  async listPendingGroupJoin(send: Send, groupId: number, signal: AbortSignal): Promise<PendingGroupJoinList | undefined> {
    if (!await this.isNapCat(send, signal) || signal.aborted) return;
    const [normal, filtered] = await Promise.all([
      this.#request(send, "get_group_system_msg", { count: 100 }, signal).catch(() => undefined),
      this.#request(send, "get_group_ignore_add_request", {}, signal).catch(() => undefined),
    ]);
    const normalRows = isRecord(normal) && Array.isArray(normal.join_requests) ? normal.join_requests : undefined;
    const filteredRows = Array.isArray(filtered) ? filtered : undefined;
    if (signal.aborted || (!normalRows && !filteredRows)) return;
    const entries = new Map<number, PendingGroupJoinEntry>();
    const conflicted = new Set<number>();
    for (const [rows, risk] of [[normalRows, false], [filteredRows, true]] as const) {
      for (const row of rows ?? []) {
        if (!isRecord(row) || row.group_id !== groupId || row.checked !== false || !isPositiveInteger(row.invitor_uin) ||
            !isPositiveInteger(row.request_id) || conflicted.has(row.request_id)) continue;
        const previous = entries.get(row.request_id);
        if (previous) {
          if (previous.userId !== row.invitor_uin) {
            entries.delete(row.request_id);
            conflicted.add(row.request_id);
          } else if (risk) entries.set(row.request_id, { ...previous, risk: true });
          continue;
        }
        entries.set(row.request_id, { userId: row.invitor_uin, nickname: memberDisplayName(row.invitor_nick),
          comment: typeof row.message === "string" ? row.message : undefined, risk });
      }
    }
    // NapCat exposes bounded screens and omits third-party join notifications.
    return { entries: [...entries.values()], complete: false };
  }

  async listPendingGroupInvitations(send: Send, account: number, signal: AbortSignal): Promise<PendingGroupInvitationList | undefined> {
    if (!await this.isNapCat(send, signal) || signal.aborted) return;
    const data = await this.#request(send, "get_group_system_msg", { count: 100 }, signal).catch(() => undefined);
    if (signal.aborted || !isRecord(data) || !Array.isArray(data.invited_requests)) return;

    const entries = new Map<string, PendingGroupInvitation>();
    const conflicted = new Set<string>();
    for (const row of data.invited_requests) {
      if (!isRecord(row) || row.checked !== false || !isPositiveInteger(row.group_id) ||
          !isPositiveInteger(row.invitor_uin) || row.invitor_uin === account || !isPositiveInteger(row.request_id)) continue;
      const key = `${row.group_id}:${row.request_id}`;
      if (conflicted.has(key)) continue;
      const existing = entries.get(key);
      if (existing) {
        if (existing.inviterId !== row.invitor_uin) {
          entries.delete(key);
          conflicted.add(key);
        }
        continue;
      }
      entries.set(key, { groupId: row.group_id, groupName: memberDisplayName(row.group_name),
        inviterId: row.invitor_uin, nickname: memberDisplayName(row.invitor_nick) });
    }
    // The gateway returns a bounded window and does not expose its live invitation-card cache here.
    return { entries: [...entries.values()], complete: false };
  }

  async listGroupAnnouncements(send: Send, groupId: number, signal: AbortSignal) {
    try {
      if (!await this.isNapCat(send, signal) || signal.aborted) return;
      const rows = await this.#request(send, "_get_group_notice", { group_id: String(groupId) }, signal);
      return readGroupAnnouncements(rows, row => {
        if (!isRecord(row) || ("group_id" in row && row.group_id !== groupId && row.group_id !== String(groupId))) return;
        if (row.send_to_new_member === true) return null;
        if (typeof row.notice_id !== "string" || !isRecord(row.message) || typeof row.message.text !== "string") return;
        return { id: row.notice_id, text: row.message.text };
      });
    } catch { return undefined; }
  }

  async isNapCat(send: Send, signal: AbortSignal): Promise<boolean> {
    try {
      const version = await this.#request(send, "get_version_info", {}, signal);
      return isRecord(version) && version.app_name === "NapCat.Onebot";
    } catch { return false; }
  }

  publishGroupAnnouncement(send: Send, groupId: number, content: string, image: string | undefined, signal: AbortSignal) {
    return this.#moderateGroup(send, "_send_group_notice", {
      group_id: String(groupId), content, ...(image === undefined ? {} : { image }),
      pinned: 0, type: 1, is_show_edit_card: 1, tip_window_type: 1, confirm_required: 1,
    }, signal);
  }

  deleteGroupAnnouncement(send: Send, groupId: number, notice_id: string, signal: AbortSignal) {
    return this.#moderateGroup(send, "_del_group_notice", { group_id: String(groupId), notice_id }, signal);
  }

  observeFriendRequest(flag: string, entry: PendingFriendRequest) {
    const now = performance.now();
    this.#pruneFriendRequests(now);
    if (this.#friendRequests.has(flag)) return;
    this.#friendRequests.set(flag, { entry, expires: now + 60 * 60 * 1_000, reviewing: 0, settled: false });
    if (this.#friendRequests.size > 1_000) this.#friendRequests.delete(this.#friendRequests.keys().next().value!);
  }

  #pruneFriendRequests(now: number) {
    for (const [flag, request] of this.#friendRequests) {
      if (request.expires > now) break;
      this.#friendRequests.delete(flag);
    }
  }

  listObservedFriendRequests(): PendingFriendRequestList {
    this.#pruneFriendRequests(performance.now());
    const entries = [...this.#friendRequests.values()].filter(request => !request.settled && !request.reviewing).map(request => request.entry).reverse();
    return { entries, complete: false };
  }

  async reviewFriendRequest(send: Send, flag: string, approve: boolean, remark = ""): Promise<boolean> {
    if (!isRequestFlag(flag) || typeof approve !== "boolean" || typeof remark !== "string" || remark.length > 512) {
      return false;
    }
    const observed = this.#friendRequests.get(flag);
    if (observed) observed.reviewing++;
    try {
      const confirmed = await this.#confirmAction(send, "set_friend_add_request", { flag, approve, remark: approve ? remark : "" });
      if (confirmed && observed) observed.settled = true;
      return confirmed;
    } catch (error) {
      if (observed && !(error instanceof OneBotNotSentError)) observed.settled = true;
      throw error;
    } finally {
      if (observed) observed.reviewing--;
    }
  }

  async #confirmAction(send: Send, action: string, params: object, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#request(send, action, params, signal);
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

  async getGroupName(send: Send, groupId: number, signal?: AbortSignal, verifyId = false): Promise<string | undefined> {
    try {
      const group = await this.#request(send, "get_group_info", { group_id: groupId }, signal);
      if (!isRecord(group) || typeof group.group_name !== "string" || (verifyId && group.group_id !== groupId)) return;
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

  async getGroupRole(send: Send, groupId: number, userId: number, verifyIds = false, signal?: AbortSignal): Promise<GroupMembership["botRole"] | undefined> {
    return (await this.getLiveGroupMember(send, groupId, userId, verifyIds, signal))?.role;
  }

  async getLiveGroupMember(send: Send, groupId: number, userId: number, verifyIds: boolean, signal?: AbortSignal): Promise<LiveGroupMember | undefined> {
    try {
      const result = await this.#getGroupMember(send, groupId, userId, signal);
      if (!isRecord(result) || (verifyIds && (result.group_id !== groupId || result.user_id !== userId))) return;
      const role = result.role;
      if (role === "member" || role === "admin" || role === "owner") {
        const last = result.last_sent_time;
        const card = memberDisplayName(result.card);
        const nickname = memberDisplayName(result.nickname);
        return { role, name: card || nickname, nickname, card,
          joinTime: isPositiveInteger(result.join_time) ? result.join_time : undefined,
          lastSentTime: typeof last === "number" && Number.isSafeInteger(last) && last >= 0 ? last : undefined };
      }
    } catch {
      return undefined;
    }
  }

  async listMutedMembers(send: Send, groupId: number, signal: AbortSignal): Promise<readonly MutedGroupMember[] | undefined> {
    try {
      const payload = await this.#request(send, "get_group_shut_list", { group_id: groupId }, signal);
      if (signal.aborted || !Array.isArray(payload) || payload.length > 10_000) return;
      const members: MutedGroupMember[] = [];
      const seen = new Set<number>();
      for (const row of payload as unknown[]) {
        if (!isRecord(row) || ("group_id" in row && row.group_id !== groupId)) return;
        const id = typeof row.uin === "string" && /^[1-9]\d*$/u.test(row.uin) ? Number(row.uin) : row.uin;
        const until = row.shutUpTime;
        if (!isPositiveInteger(id) || seen.has(id) || typeof until !== "number" || !Number.isSafeInteger(until) || until < 0) return;
        seen.add(id);
        if (row.isDelete === true || until <= Date.now() / 1000) continue;
        const role = row.role === 2 ? "member" : row.role === 3 ? "admin" : row.role === 4 ? "owner" : undefined;
        members.push({ userId: id, until, role, name: memberDisplayName(row.cardName) ?? memberDisplayName(row.nick) });
      }
      return members;
    } catch {
      return undefined;
    }
  }

  async listGroupActivity(send: Send, group: number, bot: number, actor: number, master: () => boolean, signal: AbortSignal,
    visibility?: GroupActivityVisibility) {
    try {
      const count = await this.#getGroupSize(send, group, signal);
      if (count === undefined || count > 10_000 || signal.aborted) return;
      const members = await this.#request(send, "get_group_member_list", { group_id: group, no_cache: true }, signal);
      if (signal.aborted || await this.#getGroupSize(send, group, signal) !== count || signal.aborted) return;
      return readGroupActivity(members, { group, bot, actor, master, count, visibility });
    } catch {
      return undefined;
    }
  }

  #getGroupMember(send: Send, groupId: number, userId: number, signal?: AbortSignal): Promise<unknown> {
    return this.#request(send, "get_group_member_info", { group_id: groupId, user_id: userId, no_cache: true }, signal);
  }

  async #getGroupSize(send: Send, groupId: number, signal?: AbortSignal): Promise<number | undefined> {
    const result = await this.#request(send, "get_group_info", { group_id: groupId, no_cache: true }, signal);
    if (isRecord(result) && result.group_id === groupId && isPositiveInteger(result.member_count)) return result.member_count;
  }

  async inspectAutoQuit(send: Send, groupId: number, userId: number, joinedAt: number,
    maxMembers: number, signal?: AbortSignal): Promise<GroupMembership | undefined> {
    try {
      const count = await this.#getGroupSize(send, groupId, signal);
      if (count === undefined || count > maxMembers) return;
      const members = await this.#request(send, "get_group_member_list", { group_id: groupId, no_cache: true }, signal);
      if (!Array.isArray(members) || members.length !== count) return;
      const memberIds = new Set<number>();
      let listedRole: unknown;
      for (const member of members) {
        if (!isRecord(member) || member.group_id !== groupId || !isPositiveInteger(member.user_id) || memberIds.has(member.user_id)) return;
        memberIds.add(member.user_id);
        if (member.user_id === userId) listedRole = member.role;
      }
      if (!memberIds.has(userId)) return;
      const bot = await this.#getGroupMember(send, groupId, userId, signal);
      if (!isRecord(bot) || bot.group_id !== groupId || bot.user_id !== userId || bot.role !== listedRole) return;
      if (bot.role !== "admin" && bot.role !== "member") return;
      if (isPositiveInteger(bot.join_time) && bot.join_time > joinedAt) return;
      if (await this.#getGroupSize(send, groupId, signal) !== count) return;
      return { memberIds: [...memberIds], botRole: bot.role };
    } catch {
      return undefined;
    }
  }

  leaveGroup(send: Send, groupId: number, signal?: AbortSignal): Promise<boolean> {
    return this.#confirmAction(send, "set_group_leave", { group_id: groupId, is_dismiss: false }, signal);
  }

  async leaveGroupConfirmed(send: Send, groupId: number, signal: AbortSignal): Promise<ChatFileResult> {
    if (signal.aborted) return "rejected";
    try {
      return await this.leaveGroup(send, groupId, signal) ? "confirmed" : "rejected";
    } catch (error) {
      return error instanceof OneBotNotSentError ? "rejected" : "unknown";
    }
  }

  async sendGroup(send: Send, groupId: number, message: unknown): Promise<number> {
    const result = await this.#request(send, "send_msg", {
      message_type: "group", group_id: groupId, message, auto_escape: true,
    });
    const id = this.#messageId(result);
    if (id === undefined) throw new Error("QQ 协议端未返回发送消息的编号。");
    return id;
  }

  async deleteMessage(send: Send, messageId: number, signal?: AbortSignal): Promise<void> {
    await this.#request(send, "delete_msg", { message_id: messageId }, signal);
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

  async sendForwardConfirmed(send: Send, target: { group_id: number } | { user_id: number }, messages: readonly object[], signal?: AbortSignal): Promise<ChatFileResult> {
    const action = "group_id" in target ? "send_group_forward_msg" : "send_private_forward_msg";
    try {
      const result = await this.#request(send, action, { ...target, messages }, signal);
      return this.#messageId(result) !== undefined || (isRecord(result) && typeof result.forward_id === "string" && result.forward_id.trim())
        ? "confirmed" : "unknown";
    } catch (error) {
      return error instanceof OneBotNotSentError || error instanceof OneBotRejectedError ? "rejected" : "unknown";
    }
  }

  async uploadFile(send: Send, target: { group_id: number } | { user_id: number }, file: ChatFile,
    signal?: AbortSignal): Promise<ChatFileResult> {
    const uri = encodeChatFile(file);
    if (uri === undefined) return "rejected";
    return this.uploadFileUri(send, target, uri, file.name, signal);
  }

  async uploadFileUri(send: Send, target: { group_id: number } | { user_id: number }, uri: string, name: string,
    signal?: AbortSignal): Promise<ChatFileResult> {
    const action = "group_id" in target ? "upload_group_file" : "upload_private_file";
    try {
      const result = await this.#request(send, action, { ...target, file: uri, name }, signal);
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

  async recallMessage(send: Send, messageId: number, signal?: AbortSignal): Promise<RecallResult> {
    try {
      await this.deleteMessage(send, messageId, signal);
      return "confirmed";
    } catch (error) {
      return error instanceof OneBotRejectedError || error instanceof OneBotNotSentError ? "rejected" : "unknown";
    }
  }

  readGroupFiles(send: Send, group_id: number, folder_id: string, signal: AbortSignal) {
    return folder_id === "/"
      ? this.#request(send, "get_group_root_files", { group_id, file_count: 10_000 }, signal)
      : this.#request(send, "get_group_files_by_folder", { group_id, folder_id, file_count: 10_000 }, signal);
  }

  async deleteGroupFile(send: Send, group_id: number, file_id: string, busid: number, signal: AbortSignal): Promise<RecallResult> {
    try {
      const response = await this.#request(send, "delete_group_file", { group_id, file_id, busid }, signal);
      // Some gateways expose only the action receipt. NapCat also returns the individual native result.
      if (response == null || (isRecord(response) && !Object.keys(response).length)) return "confirmed";
      if (!isRecord(response)) return "unknown";
      if (typeof response.result === "number" && response.result !== 0) return "rejected";
      const detail = response.transGroupFileResult;
      if (!isRecord(detail) || !isRecord(detail.result)) return "unknown";
      if (typeof detail.result.retCode === "number" && detail.result.retCode !== 0) return "rejected";
      if (Array.isArray(detail.failFileIdList) && detail.failFileIdList.length) return "rejected";
      return response.result === 0 && detail.result.retCode === 0 && Array.isArray(detail.failFileIdList) &&
        Array.isArray(detail.successFileIdList) && detail.successFileIdList.length === 1 &&
        detail.successFileIdList[0] === file_id ? "confirmed" : "unknown";
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
    if (typeof id === "number" && Number.isInteger(id) && id !== 0 && id >= -2_147_483_648 && id <= 2_147_483_647) return id;
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
