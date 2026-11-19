import type { CheckinNotifyDelivery, CheckinNotifyTransport } from "../checkin-notify.ts";
import { delegationSession, type DelegationSession } from "../command-delegation.ts";
import type { BotEvent, MessageReply } from "../messages.ts";
import { bindGroupCard } from "./group-card.ts";
import { bindGroupModeration, bindMessageGroupActions, canModerateGroupSubject, type GroupActionPolicy } from "./group-moderation.ts";
import { bindMentionLike, mentionedProfileId } from "./mention-like.ts";
import { createMilkyApi } from "./milky-api.ts";
import type { MilkySettings } from "./milky-config.ts";
import { milkyFriendRequest } from "./milky-friend-request.ts";
import { milkyGroupRequest } from "./milky-group-request.ts";
import { createMilkyGroupReviews } from "./milky-group-reviews.ts";
import { createMilkyGroupMute } from "./milky-group-mute.ts";
import { createMilkyFileDelivery } from "./milky-file-delivery.ts";
import { encodeMilkyForward, encodeMilkyReply, milkyFriendFileUpload, milkyMessage } from "./milky-message.ts";
import { milkyNotice } from "./milky-notice.ts";
import { createMilkyRecallReply } from "./milky-recall-reply.ts";
import { bindOwnGroupCard, ownGroupCardSession, type OwnGroupCardAccount } from "./own-group-card.ts";

type MessageRecipient = { readonly group_id?: number; readonly user_id?: number };

export interface MilkyTransportOptions extends GroupActionPolicy {
  readonly signal: AbortSignal;
  readonly dispatch: (event: BotEvent) => Promise<void>;
  readonly onSent?: (identity: MessageRecipient & { readonly self_id: number }, message: unknown) => void;
  readonly masterIds?: (botId: number) => readonly number[];
  readonly onOnline?: (botId: number, signal: AbortSignal, send: MilkySession["send"], checkinNotify: CheckinNotifyTransport,
    ownGroupCardAccount: OwnGroupCardAccount) => void;
  readonly isMaster?: (botId: number, userId: number) => boolean;
  readonly groupReviews?: ReturnType<typeof createMilkyGroupReviews>;
}

export interface MilkySession {
  readonly botId: number;
  readonly checkinNotify: CheckinNotifyTransport;
  readonly ownGroupCardAccount: OwnGroupCardAccount;
  send(target: { group_id: number } | { user_id: number }, reply: MessageReply): Promise<boolean>;
  receive(value: unknown): "accepted" | "invalid" | "foreign" | "offline";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasMessageSequence(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const maxGroupMembers = 10_000;

export async function openMilkySession(settings: MilkySettings, options: MilkyTransportOptions): Promise<MilkySession | undefined> {
  const { signal, dispatch, onSent } = options;
  const call = createMilkyApi(settings, signal);
  const login = await call("get_login_info", {});
  if (signal.aborted || !positiveId(login?.uin)) return;
  const account = login.uin;
  const groupReviews = options.groupReviews ?? createMilkyGroupReviews();
  const groupMute = createMilkyGroupMute(account, signal, call.confirmed);
  const isMaster = (userId: number) => options.isMaster?.(account, userId) === true;
  const recallReply = createMilkyRecallReply(signal, call.confirmed, isMaster);

  async function likeProfile(user_id: number, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 10 || signal.aborted) throw new Error("当前会话无法提交点赞。");
    const result = await call.confirmed("send_profile_like", { user_id, count });
    if (result.status === "unknown") throw new Error("Milky 点赞结果未确认。");
    return result.status === "confirmed" ? count : 0;
  }

  function confirmSent(recipient: MessageRecipient | undefined, result: Record<string, unknown> | undefined, content: unknown) {
    if (recipient && hasMessageSequence(result?.message_seq)) {
      onSent?.({ self_id: account, group_id: recipient.group_id, user_id: recipient.user_id }, content);
    }
    return result;
  }

  const recalls = new Set<ReturnType<typeof setTimeout>>();
  const reviewedFriendRequests = new Set<string>();
  async function dispatchEvent(event: BotEvent) {
    if (event.post_type === "message" && event.message_type === "group" && event.group_id !== undefined) {
      const botMute = await groupMute.forMessage(event.group_id);
      if (botMute) event = { ...event, botMute };
    }
    if (signal.aborted) return;
    if (event.post_type === "message") {
      event = { ...event, canManageProcess: positiveId(event.user_id) && isMaster(event.user_id) };
      const { group_id, user_id } = event;
      if (event.message_type === "group" && positiveId(group_id) && positiveId(user_id) && !event.attachmentOnly) {
        bindGroupModeration(event, {
          signal,
          canModerate: () => canModerateGroupSubject(id => delegation.memberRole(group_id, id), account, user_id),
          async act(active) { return (await call.confirmed("kick_group_member", { group_id, user_id }, active)).status; },
        });
      }
    } else if (event.post_type === "notice" && event.notice_type === "friend") {
      event = { ...event, isMaster: isMaster(event.user_id) };
    }
    await dispatch(event);
  }

  function deliver(event: BotEvent) {
    void dispatchEvent(event).catch(() => console.warn("[Milky] 处理事件失败。"));
  }
  const files = createMilkyFileDelivery(signal, (event) => deliver({ ...event, adapter: "milky" }));
  signal.addEventListener("abort", () => {
    for (const timer of recalls) clearTimeout(timer);
    recalls.clear();
  }, { once: true });

  function scheduleRecall(action: string, params: Record<string, unknown>, seconds: number) {
    if (signal.aborted) return;
    const timer = setTimeout(async () => {
      recalls.delete(timer);
      if (!await call(action, params) && !signal.aborted) console.warn("[Milky] 消息撤回未获确认。");
    }, seconds * 1_000);
    timer.unref();
    recalls.add(timer);
  }

  async function approveFriendRequest(flag: string, action: string, params: Record<string, unknown>) {
    if (signal.aborted || reviewedFriendRequests.has(flag)) return false;
    reviewedFriendRequests.add(flag);
    if (reviewedFriendRequests.size > 4096) reviewedFriendRequests.delete(reviewedFriendRequests.values().next().value!);
    const result = await call.confirmed(action, params);
    if (result.status === "unknown") throw new Error("Milky 好友审批结果未确认。");
    return result.status === "confirmed";
  }

  async function sendConfirmed(target: { group_id: number } | { user_id: number }, reply: MessageReply): Promise<CheckinNotifyDelivery> {
    const group = "group_id" in target;
    if (signal.aborted || !positiveId(group ? target.group_id : target.user_id)) return "rejected";
    const message = encodeMilkyReply(reply);
    if (!message) return "rejected";
    const result = await call.confirmed(group ? "send_group_message" : "send_private_message", { ...target, message });
    if (result.status !== "confirmed") return result.status;
    if (!hasMessageSequence(result.data.message_seq)) return "unknown";
    confirmSent(target, result.data, message);
    return "confirmed";
  }

  const checkinNotify: CheckinNotifyTransport = {
    async isFriend(user_id) {
      if (signal.aborted || !positiveId(user_id)) return false;
      const result = await call.confirmed("get_friend_info", { user_id, no_cache: true });
      return !signal.aborted && result.status === "confirmed" && record(result.data.friend) &&
        result.data.friend.user_id === user_id;
    },
    async isGroupMember(group_id, user_id) {
      if (signal.aborted || !positiveId(group_id) || !positiveId(user_id)) return false;
      const result = await call.confirmed("get_group_member_info", { group_id, user_id, no_cache: true });
      return !signal.aborted && result.status === "confirmed" && record(result.data.member) &&
        result.data.member.group_id === group_id && result.data.member.user_id === user_id;
    },
    sendPrivate: (user_id, reply) => sendConfirmed({ user_id }, reply),
    sendGroup: (group_id, reply) => sendConfirmed({ group_id }, reply),
    async sendForward({ groupId, userId }, nodes) {
      const messages = encodeMilkyForward(nodes, account);
      if (signal.aborted || !messages || !positiveId(groupId ?? userId)) return "rejected";
      const params = groupId === undefined ? { user_id: userId } : { group_id: groupId };
      const message = [{ type: "forward", data: { messages } }];
      const result = await call.confirmed(groupId === undefined ? "send_private_message" : "send_group_message", { ...params, message });
      if (result.status !== "confirmed") return result.status;
      if (!hasMessageSequence(result.data.message_seq)) return "unknown";
      confirmSent(params, result.data, message);
      return "confirmed";
    },
  };

  async function listGroupMembers(group_id: number) {
    if (signal.aborted) return;
    const result = await call.confirmed("get_group_member_list", { group_id, no_cache: true });
    if (signal.aborted || result.status !== "confirmed") return;
    const { members } = result.data;
    if (!Array.isArray(members) || members.length > maxGroupMembers) return;
    const seen = new Set<number>();
    const roster: { id: number; name?: string }[] = [];
    for (const member of members) {
      if (!record(member) || member.group_id !== group_id || !positiveId(member.user_id) || seen.has(member.user_id)) return;
      seen.add(member.user_id);
      const card = typeof member.card === "string" ? member.card.trim() : "";
      const nickname = typeof member.nickname === "string" ? member.nickname.trim() : "";
      const name = card || nickname;
      roster.push({ id: member.user_id, ...(name && { name }) });
    }
    return roster;
  }

  const delegation: DelegationSession = {
    signal,
    async groups() {
      const result = await call.confirmed("get_group_list", { no_cache: true });
      const groups = result.status === "confirmed" ? result.data.groups : undefined;
      if (signal.aborted || !Array.isArray(groups)) return [];
      return groups.flatMap(group => record(group) && positiveId(group.group_id) ? [group.group_id] : []);
    },
    async members(groupId) { return (await listGroupMembers(groupId) ?? []).map(({ id }) => id); },
    isFriend: checkinNotify.isFriend,
    botMute: groupMute.forMessage,
    async memberRole(group_id, user_id) {
      if (signal.aborted) return;
      const result = await call.confirmed("get_group_member_info", { group_id, user_id, no_cache: true });
      const member = result.status === "confirmed" ? result.data.member : undefined;
      if (signal.aborted || !record(member) || member.group_id !== group_id || member.user_id !== user_id) return;
      if (member.role === "member" || member.role === "admin" || member.role === "owner") return member.role;
    },
    send: ({ groupId, userId }, reply) => sendConfirmed(groupId === undefined ? { user_id: userId } : { group_id: groupId }, reply),
  };

  const bindCard = (authorize?: () => boolean) => bindOwnGroupCard({
    adapter: "milky", botId: account, signal,
    nickname: typeof login.nickname === "string" ? login.nickname : undefined,
    async groups() {
      const result = await call.confirmed("get_group_list", { no_cache: true });
      const groups = result.status === "confirmed" ? result.data.groups : undefined;
      if (Array.isArray(groups) && groups.every(group => record(group) && positiveId(group.group_id))) {
        return groups.map(group => group.group_id);
      }
    },
    async read(group_id) {
      const result = await call.confirmed("get_group_member_info", { group_id, user_id: account, no_cache: true });
      const member = result.status === "confirmed" ? result.data.member : undefined;
      if (record(member) && member.group_id === group_id && member.user_id === account && typeof member.card === "string") {
        return member.card;
      }
    },
    async write(group_id, card) {
      return (await call.confirmed("set_group_member_card", { group_id, user_id: account, card })).status;
    },
  }, authorize);

  return { botId: account, checkinNotify, ownGroupCardAccount: bindCard(), async send(target, reply) {
    return await sendConfirmed(target, reply) === "confirmed";
  }, receive(body) {
    if (signal.aborted) return "offline";
    if (!record(body) || !positiveId(body.self_id) || typeof body.event_type !== "string" ||
        !body.event_type || !record(body.data)) return "invalid";
    if (body.self_id !== account) return "foreign";
    if (body.event_type === "bot_offline") return "offline";
    groupMute.observe(body);

    if (body.event_type === "friend_file_upload") {
      const upload = milkyFriendFileUpload(body, account, async (action, params) => {
        return confirmSent(upload, await call(action, params), params.message);
      }, call.confirmed);
      if (upload) files.upload(upload);
      return "accepted";
    }

    const message = milkyMessage(body, account, async (action, params) => {
      return confirmSent(message, await call(action, params), params.message);
    }, scheduleRecall, async (action, params) => {
      const result = await call.confirmed(action, params);
      if (result.status === "unknown") throw new Error("Milky 转发回执未确认。");
      if (result.status === "confirmed") return confirmSent(message, result.data, params.message);
    }, call.confirmed);
    if (message && !files.receive(message)) return "accepted";
    async function sendReply(target: { group_id: number } | { user_id: number }, reply: MessageReply) {
      const content = encodeMilkyReply(reply);
      if (!content) return false;
      const action = "group_id" in target ? "send_group_message" : "send_private_message";
      const result = await call.confirmed(action, { ...target, message: content });
      if (result.status === "rejected") return false;
      if (result.status === "unknown" || !hasMessageSequence(result.data.message_seq)) {
        throw new Error("Milky 通知回复未确认。");
      }
      confirmSent(target, result.data, content);
      return true;
    }

    const friendRequest = body.event_type === "friend_request"
      ? milkyFriendRequest(body, account, approveFriendRequest, (user_id, reply) => sendReply({ user_id }, reply), options.masterIds?.(account) ?? [])
      : undefined;
    let groupRequest;
    if (body.event_type === "group_invitation" || body.event_type === "group_join_request" || body.event_type === "group_invited_join_request") {
      const kind = body.event_type === "group_invitation" ? "invite" : "add";
      const candidate = milkyGroupRequest(body, account, {
        isMaster,
        approve: (flag, accept, reason) => signal.aborted ? Promise.resolve(false)
          : groupReviews.review(account, flag, kind, accept, reason, call.confirmed),
        sendGroup: (group_id, reply) => sendReply({ group_id }, reply),
        sendPrivate: (user_id, reply) => sendReply({ user_id }, reply),
        masterIds: options.masterIds?.(account) ?? [],
      });
      if (candidate) {
        const { decision, ...request } = candidate;
        if (groupReviews.register(request, decision)) {
          groupRequest = request;
          if (kind === "add") bindGroupModeration(request, {
            signal,
            canModerate: () => canModerateGroupSubject(id => delegation.memberRole(request.group_id, id), account),
            async act(active, reason = "主动退群被拉黑") {
              if (active.aborted || signal.aborted) return "rejected";
              try {
                return await groupReviews.review(account, request.flag, kind, false, reason,
                  (action, params) => call.confirmed(action, params, active)) ? "confirmed" : "rejected";
              } catch {
                return "unknown";
              }
            },
          });
        }
      }
    }
    const canReview = message?.isPrivate === true && positiveId(message.user_id) && isMaster(message.user_id);
    const groupId = message?.isGroup ? message.group_id : undefined;
    const mentioned = message && positiveId(groupId) && positiveId(message.user_id)
      ? mentionedProfileId(message.message, account, message.user_id) : undefined;
    const listCurrentGroupMembers = positiveId(groupId) ? () => listGroupMembers(groupId) : undefined;
    const cardOwner = message?.user_id;
    const scopedMessage = message && {
      ...message, adapter: "milky" as const, groupRequestScope: "milky" as const, canReviewGroupRequests: canReview,
      [delegationSession]: delegation,
      likeSelf: positiveId(cardOwner) ? (count: number) => likeProfile(cardOwner, count) : undefined,
      profileLikeImageSignal: signal,
      mentionLike: positiveId(groupId) && mentioned !== undefined ? bindMentionLike(mentioned, signal,
        () => checkinNotify.isGroupMember(groupId, mentioned),
        () => checkinNotify.isFriend(mentioned),
        count => likeProfile(mentioned, count))
        : undefined,
      ...(positiveId(groupId) && positiveId(cardOwner) && bindMessageGroupActions({
        bot: account, actor: cardOwner, signal,
        accepting: options.canModerateGroups,
        isMaster: () => isMaster(cardOwner),
        isProtected: id => options.isProtectedMaster?.(account, id) ?? isMaster(id),
        role: id => delegation.memberRole(groupId, id),
        async mute(user_id, duration) {
          return (await call.confirmed("set_group_member_mute", { group_id: groupId, user_id, duration }, signal)).status;
        },
        async wholeMute(is_mute) {
          return (await call.confirmed("set_group_whole_mute", { group_id: groupId, is_mute }, signal)).status;
        },
        async kick(user_id, reject_add_request) {
          return (await call.confirmed("kick_group_member", { group_id: groupId, user_id, reject_add_request }, signal)).status;
        },
      })),
      listCurrentGroupMembers, listCheckinGroupMembers: listCurrentGroupMembers,
      [ownGroupCardSession]: positiveId(cardOwner) && isMaster(cardOwner) && (positiveId(groupId) || message.sub_type === "friend")
        ? () => bindCard(() => isMaster(cardOwner)) : undefined,
      privateCredentialSignal: message.isPrivate ? signal : undefined,
      isOwnerEnrollmentSession: message.isPrivate ? () => !signal.aborted : undefined,
      recallReply: recallReply(message),
      setGroupCard: positiveId(cardOwner) && isMaster(cardOwner) && Array.isArray(message.message) &&
          (positiveId(groupId) || message.sub_type === "friend") ? bindGroupCard({
        botId: account,
        groupId,
        message: message.message,
        active: () => !signal.aborted && isMaster(cardOwner),
        memberRole: delegation.memberRole,
        async write(group_id, user_id, card) {
          return (await call.confirmed("set_group_member_card", { group_id, user_id, card })).status;
        },
      }) : undefined,
      reviewGroupRequest: canReview ? (flag: string, kind: "add" | "invite", accept: boolean, reason?: string) =>
        !signal.aborted && positiveId(message.user_id) && isMaster(message.user_id)
          ? groupReviews.review(account, flag, kind, accept, reason, call.confirmed)
          : Promise.resolve(false) : undefined,
    };
    const event = scopedMessage ?? friendRequest ?? groupRequest ?? milkyNotice(body, account, call, sendReply, async (group_id) => {
      const result = await call.confirmed("quit_group", { group_id });
      if (result.status === "unknown") throw new Error("Milky 退群回执未确认。");
      return result.status === "confirmed";
    });
    if (event?.post_type === "notice" && event.notice_type === "group") {
      const { group_id, user_id } = event;
      bindGroupModeration(event, {
        signal,
        canModerate: () => canModerateGroupSubject(id => delegation.memberRole(group_id, id), account, user_id),
        act: event.sub_type === "increase" && user_id !== account
          ? async active => (await call.confirmed("kick_group_member", { group_id, user_id }, active)).status
          : undefined,
      });
    }
    if (event) deliver(event);
    return "accepted";
  } };
}
