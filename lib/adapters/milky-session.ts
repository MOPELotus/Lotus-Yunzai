import type { CheckinNotifyDelivery, CheckinNotifyTransport } from "../checkin-notify.ts";
import { delegationSession, type DelegationSession } from "../command-delegation.ts";
import { bindQuotedOwnerFriendReply, friendMessageNoticeSession,
  type FriendMessageNoticeSession, type FriendMessageReceipts } from "../friend-message-notice.ts";
import { notifyReplyDelivery, pokeDeliverySession, type BotEvent, type MessageReply, type PokeDeliverySession,
  type QuotedMessage, type ReplyOptions } from "../messages.ts";
import { confirmJoinReview, type JoinRequestOrigin, type PendingGroupJoinBatch, type PendingGroupJoinDecision, type PendingGroupJoinEntry } from "../group-join-review.ts";
import type { PendingFriendRequestDecision } from "../friend-requests.ts";
import type { PendingGroupInvitationDecision, QuotedGroupInvitationDecision } from "../group-invitations.ts";
import { createRequestClaim } from "../request-claim.ts";
import { hashPrivateNotice, privateNoticeText } from "../private-notice-receipts.ts";
import { bindGroupCard } from "./group-card.ts";
import { bindGroupModeration, bindGroupRuleImageDigest, bindGroupVerificationScope, bindMessageGroupActions, bindMixedGroupImageParts,
  bindPrivateGroupActions, bindSingleGroupImageDigest, canModerateGroupSubject,
  groupMayReadPendingJoins, groupOperatorAuthority, isMemberMuteDuration, readGroupActivity, readGroupAnnouncements,
  runTimedWholeMute, type GroupActionPolicy, type GroupActivityVisibility, type LiveGroupMember, type TimedGroupMuteBinding,
  type TimedGroupMuteResult } from "./group-moderation.ts";
import { bindMentionLike, mentionedProfileId } from "./mention-like.ts";
import { createMilkyApi } from "./milky-api.ts";
import type { MilkySettings } from "./milky-config.ts";
import { milkyFriendRequest, milkyFriendRequestLimit, milkyFriendRequestState, milkyPendingFriendRequests,
  selectCurrentMilkyFriendRequest } from "./milky-friend-request.ts";
import { milkyGroupRequest, milkyGroupRequestFlag } from "./milky-group-request.ts";
import { createMilkyGroupReviews } from "./milky-group-reviews.ts";
import type { createMilkyInvitationReceipts } from "./milky-invitation-receipts.ts";
import { createMilkyGroupMute } from "./milky-group-mute.ts";
import { createMilkyFileDelivery } from "./milky-file-delivery.ts";
import { decodeMilkyTemporaryMessage, encodeMilkyForward, encodeMilkyReply, milkyFriendFileUpload, milkyMessage } from "./milky-message.ts";
import { milkyNotice } from "./milky-notice.ts";
import { createMilkyRecallReply } from "./milky-recall-reply.ts";
import { NoticeNotSentError, type NoticeGroupAccount } from "./notice-groups.ts";
import { memberDisplayName } from "./onebot-member-display.ts";
import { bindOwnGroupCard, ownGroupCardSession, type OwnGroupCardAccount } from "./own-group-card.ts";
import { bindOwnerFriendReply } from "./owner-friend-reply.ts";

type MessageRecipient = { readonly group_id?: number; readonly user_id?: number };
type MilkyJoinOrigin = Extract<JoinRequestOrigin, { adapter: "milky" }>;
type MilkyPendingJoin = PendingGroupJoinEntry & { readonly origin: MilkyJoinOrigin };

export interface MilkyTransportOptions extends GroupActionPolicy {
  readonly signal: AbortSignal;
  readonly dispatch: (event: BotEvent) => Promise<void>;
  readonly accepting?: () => boolean;
  readonly onNoticeAttempt?: (attempt: Promise<unknown>) => void;
  readonly friendReview?: ReturnType<typeof createRequestClaim>;
  readonly invitationReview?: ReturnType<typeof createRequestClaim>;
  readonly invitationReceipts?: ReturnType<typeof createMilkyInvitationReceipts>;
  readonly friendNoticeReceipts?: FriendMessageReceipts;
  readonly ownerFriendReplyClaim?: ReturnType<typeof createRequestClaim>;
  readonly onSent?: (identity: MessageRecipient & { readonly self_id: number }, message: unknown) => void;
  readonly masterIds?: (botId: number) => readonly number[];
  readonly onOnline?: (botId: number, signal: AbortSignal, send: MilkySession["send"], checkinNotify: CheckinNotifyTransport,
    ownGroupCardAccount: OwnGroupCardAccount, timedWholeMute: MilkySession["timedWholeMute"], noticeAccount: NoticeGroupAccount) => void;
  readonly isMaster?: (botId: number, userId: number) => boolean;
  readonly groupReviews?: ReturnType<typeof createMilkyGroupReviews>;
}

export interface MilkySession {
  readonly botId: number;
  readonly checkinNotify: CheckinNotifyTransport;
  readonly ownGroupCardAccount: OwnGroupCardAccount;
  readonly noticeAccount: NoticeGroupAccount;
  timedWholeMute(binding: TimedGroupMuteBinding, signal: AbortSignal): Promise<TimedGroupMuteResult>;
  send(target: { group_id: number } | { user_id: number }, reply: MessageReply): Promise<boolean>;
  receive(value: unknown): "accepted" | "invalid" | "foreign" | "offline";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasMessageSequence(value: unknown): value is number {
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
  const friendReview = options.friendReview ?? createRequestClaim(() => undefined);
  const invitationReview = options.invitationReview ?? createRequestClaim(() => undefined);
  const invitationReceipts = options.invitationReceipts;
  const joinReview = options.joinReview;
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
      const { group_id, user_id, message_id } = event;
      if (event.message_type === "group" && positiveId(group_id) && positiveId(user_id) && !event.attachmentOnly) {
        const checkRole = (active: AbortSignal, subject?: number, permitAdmin?: boolean) =>
          canModerateGroupSubject(id => memberRole(group_id, id, active), account, subject, permitAdmin);
        bindGroupModeration(event, {
          signal,
          canModerate: active => checkRole(active, user_id),
          async act(active) { return (await call.confirmed("kick_group_member", { group_id, user_id }, active)).status; },
          memberMessage: message_id === undefined ? undefined : {
            readImageMd5: bindSingleGroupImageDigest(event.message),
            mixedImageParts: bindMixedGroupImageParts(event.message),
            canAct: active => checkRole(active, user_id, false),
            botCanAct: active => checkRole(active),
            async mute(duration, active) {
              return (await call.confirmed("set_group_member_mute", { group_id, user_id, duration }, active)).status;
            },
            async recall(active) {
              return (await call.confirmed("recall_group_message", { group_id, message_seq: message_id }, active)).status;
            },
            async send(reply, active) {
              return await sendConfirmed({ group_id }, reply, undefined, active) === "confirmed";
            },
          },
        });
      }
    } else if (event.post_type === "notice" && event.sub_type === "poke") {
      const userId = event.user_id;
      const target = event.notice_type === "group" ? { group_id: event.group_id } : { user_id: userId };
      const delivery: PokeDeliverySession = {
        signal,
        async send(reply, active) {
          return await sendConfirmed(target, reply, undefined, AbortSignal.any([signal, active])) === "confirmed";
        },
      };
      const identity = { adapter: "milky" as const, isMaster: isMaster(userId), [pokeDeliverySession]: delivery };
      event = event.notice_type === "group" ? { ...event, ...identity } : {
        ...event, ...identity, [friendMessageNoticeSession]: {
          signal,
          async notifyOwners(reply, workflow) {
            const active = AbortSignal.any([signal, workflow]);
            const friends = await listCurrentFriends(active);
            return friends?.has(userId) ? notifyOwnerReplies(reply, active, undefined, friends) : 0;
          },
        },
      };
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
    const uid = params.initiator_uid;
    if (signal.aborted || typeof uid !== "string" || reviewedFriendRequests.has(flag)) return false;
    reviewedFriendRequests.add(flag);
    if (reviewedFriendRequests.size > 4096) reviewedFriendRequests.delete(reviewedFriendRequests.values().next().value!);
    const status = await friendReview({ adapter: "milky", botId: account, flag: uid }, async () =>
      (await call.confirmed(action, params)).status);
    if (status === "unknown") throw new Error("Milky 好友审批结果未确认。");
    return status === "confirmed";
  }

  async function readFriendRequestWindow(is_filtered: boolean, active: AbortSignal) {
    const result = await call.confirmed("get_friend_requests", { limit: milkyFriendRequestLimit, is_filtered }, active);
    return result.status === "confirmed" ? result.data : undefined;
  }

  function readFriendRequestWindows(active: AbortSignal) {
    return Promise.all([readFriendRequestWindow(false, active), readFriendRequestWindow(true, active)]);
  }

  async function reviewCurrentFriendRequest(actor: number, user: number, approve: boolean, scope: AbortSignal): Promise<PendingFriendRequestDecision> {
    const active = () => !scope.aborted && isMaster(actor);
    if (!active() || !positiveId(user) || user === account || typeof approve !== "boolean") return { status: "unavailable" };
    const select = async () => selectCurrentMilkyFriendRequest(account, user, ...await readFriendRequestWindows(scope));
    const selected = await select();
    if (!active()) return { status: "unavailable" };
    if (selected.status !== "pending") return { status: selected.status };

    const { identity } = selected;
    // The native write is by UID. The event timestamp need not equal the request-list timestamp.
    const status = await friendReview({ adapter: "milky", botId: account, flag: identity.uid }, async () => {
      if (!active()) return "unavailable";
      const current = await select();
      if (!active() || current.status !== "pending" || current.identity.flag !== identity.flag) return "unavailable";
      return (await call.confirmed(approve ? "accept_friend_request" : "reject_friend_request", {
        initiator_uid: identity.uid, is_filtered: false,
      }, scope)).status;
    });
    if (status !== "confirmed" || !active()) return { status };
    const current = await readFriendRequestWindow(false, scope);
    return { status: milkyFriendRequestState(account, identity, current) === (approve ? "accepted" : "rejected") ? "confirmed" : "submitted" };
  }

  function submitGroupInvitation(flag: string, approve: boolean, scope: AbortSignal, authorized: () => boolean) {
    return invitationReview({ adapter: "milky", botId: account, flag }, async () => {
      if (scope.aborted || !authorized()) return "unavailable";
      const confirmed = await groupReviews.review(account, flag, "invite", approve, undefined,
        (action, params) => call.confirmed(action, params, scope));
      return confirmed ? "confirmed" : "rejected";
    });
  }

  async function submitGroupRequest(flag: string, kind: "add" | "invite", approve: boolean, reason?: string,
    scope = signal, authorize = () => true) {
    const active = () => !scope.aborted && authorize();
    if (!active()) return false;
    if (kind === "add") {
      return confirmJoinReview(joinReview, { adapter: "milky", botId: account, flag },
        () => active() ? groupReviews.review(account, flag, kind, approve, reason,
          (action, params) => call.confirmed(action, params, scope)) : Promise.resolve(false));
    }
    const result = await submitGroupInvitation(flag, approve, scope, active);
    if (result === "unknown") throw new Error("Milky 群邀请审核结果未确认。");
    return result === "confirmed";
  }

  async function reviewCurrentGroupInvitation(actor: number, groupId: number, approve: boolean,
    scope: AbortSignal): Promise<PendingGroupInvitationDecision> {
    const active = () => !scope.aborted && isMaster(actor);
    if (!active() || !positiveId(groupId) || typeof approve !== "boolean") return { status: "unavailable" };
    const selected = groupReviews.selectObservedInvitation(account, groupId);
    if (selected.status !== "pending") return { status: selected.status };
    const status = await submitGroupInvitation(selected.flag, approve, scope, () => {
      if (!active()) return false;
      const current = groupReviews.selectObservedInvitation(account, groupId);
      return current.status === "pending" && current.flag === selected.flag;
    });
    return status === "confirmed" ? { status, resolvedFlag: selected.flag } : { status };
  }

  async function reviewQuotedGroupInvitation(actor: number, message: number, approve: boolean, scope: AbortSignal,
    lookupReply: () => Promise<QuotedMessage | undefined>): Promise<QuotedGroupInvitationDecision> {
    const active = () => !scope.aborted && isMaster(actor);
    if (!invitationReceipts || !active() || typeof approve !== "boolean") return { status: "unrelated" };
    const receipt = await invitationReceipts.read({ account, owner: actor, message });
    if (!receipt || !active()) return { status: "unrelated" };
    const source = await lookupReply();
    if (source?.user_id !== account || !active()) return { status: "unrelated" };
    const rich = receipt.origin.groupAvatar === true;
    if (rich && source.message[0]?.type !== "image") return { status: "unrelated" };
    const text = privateNoticeText(rich ? source.message.slice(1) : source.message, false);
    if (!text || hashPrivateNotice(text) !== receipt.noticeHash) return { status: "unrelated" };
    if (receipt.expires <= Date.now()) return { status: "expired" };
    const { groupId, inviterId, sequence } = receipt.origin;
    const flag = milkyGroupRequestFlag(account, "group_invitation", groupId, sequence, false);
    const status = await invitationReview({ adapter: "milky", botId: account, flag }, async () => {
      if (!active() || receipt.expires <= Date.now()) return "unavailable";
      groupReviews.register({ self_id: account, sub_type: "invite", flag, group_id: groupId, user_id: inviterId }, accept => ({
        action: accept ? "accept_group_invitation" : "reject_group_invitation", params: { group_id: groupId, invitation_seq: sequence },
      }));
      const result = await groupReviews.review(account, flag, "invite", approve, undefined,
        (action, params) => call.confirmed(action, params, scope));
      return result ? "confirmed" : "rejected";
    });
    return status === "confirmed" ? { status, groupId, resolvedFlag: flag } : { status };
  }

  async function sendConfirmed(target: { group_id: number } | { user_id: number }, reply: MessageReply, quoted?: number,
    active = signal, onDelivered?: ReplyOptions["onDelivered"]): Promise<CheckinNotifyDelivery> {
    const group = "group_id" in target;
    if (signal.aborted || active.aborted || !positiveId(group ? target.group_id : target.user_id)) return "rejected";
    const message = encodeMilkyReply(reply, quoted);
    if (!message) return "rejected";
    const result = await call.confirmed(group ? "send_group_message" : "send_private_message", { ...target, message }, active);
    if (result.status !== "confirmed") return result.status;
    if (!hasMessageSequence(result.data.message_seq)) return "unknown";
    confirmSent(target, result.data, message);
    await notifyReplyDelivery(onDelivered, result.data.message_seq);
    return "confirmed";
  }

  async function listCurrentFriends(active: AbortSignal): Promise<ReadonlySet<number> | undefined> {
    const result = await call.confirmed("get_friend_list", { no_cache: true }, active);
    const friends = result.status === "confirmed" ? result.data.friends : undefined;
    if (!Array.isArray(friends) || friends.some(friend => !record(friend) || !positiveId(friend.user_id))) return;
    return new Set(friends.map(friend => friend.user_id as number));
  }

  async function selectNoticeOwners(active: AbortSignal) {
    if (active.aborted) return [];
    const owners = await (options.noticeOwnerIds?.(account, active) ?? options.masterIds?.(account) ?? []);
    return active.aborted ? [] : [...new Set(owners)].filter(id => id !== account && isMaster(id));
  }

  async function notifyOwnerReplies(reply: MessageReply, workflow: AbortSignal,
    onDelivered?: (owner: number, messageId: number) => Promise<void>, friends?: ReadonlySet<number>, followup?: MessageReply) {
    const active = AbortSignal.any([signal, workflow]);
    if (active.aborted) return 0;
    const recipients = (await selectNoticeOwners(active)).filter(id => friends?.has(id) !== false);
    const deliveries = await Promise.all(recipients.map(async user_id => {
      const target = { user_id };
      const status = await sendConfirmed(target, reply, undefined, active, onDelivered ? id => onDelivered(user_id, id) : undefined);
      if (status === "confirmed" && followup !== undefined && !active.aborted && isMaster(user_id)) {
        await sendConfirmed(target, followup, undefined, active);
      }
      return status;
    }));
    return deliveries.filter(result => result === "confirmed").length;
  }

  async function notifyVerifiedOwnerReplies(reply: MessageReply, workflow: AbortSignal, followup?: MessageReply, source?: number) {
    const active = AbortSignal.any([signal, workflow]);
    const friends = await listCurrentFriends(active);
    return friends && (source === undefined || friends.has(source)) ? notifyOwnerReplies(reply, active, undefined, friends, followup) : 0;
  }

  async function readVerifiedGroupName(groupId: number, active: AbortSignal) {
    const response = await call.confirmed("get_group_info", { group_id: groupId, no_cache: true }, active);
    const group = response.status === "confirmed" ? response.data.group : undefined;
    if (record(group) && group.group_id === groupId) return memberDisplayName(group.group_name);
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

  async function listGroupActivity(group_id: number, actor: number, visibility?: GroupActivityVisibility) {
    async function readCount() {
      const result = await call.confirmed("get_group_info", { group_id, no_cache: true });
      const group = result.status === "confirmed" ? result.data.group : undefined;
      if (record(group) && group.group_id === group_id && positiveId(group.member_count)) return group.member_count;
    }
    const count = await readCount();
    if (count === undefined || count > maxGroupMembers || signal.aborted) return;
    const result = await call.confirmed("get_group_member_list", { group_id, no_cache: true });
    if (result.status !== "confirmed" || signal.aborted || await readCount() !== count || signal.aborted) return;
    return readGroupActivity(result.data.members, { group: group_id, bot: account, actor,
      master: () => isMaster(actor), count, visibility });
  }

  async function verifyPendingGroupJoin(origin: MilkyJoinOrigin, active = signal) {
    if (origin.filtered) return "risk" as const;
    const visited = new Set<number>();
    let start_notification_seq: number | undefined;
    for (let page = 0; page < 8 && !active.aborted; page++) {
      const result = await call.confirmed("get_group_notifications", { is_filtered: false, limit: 50,
        ...(start_notification_seq === undefined ? {} : { start_notification_seq }) }, active);
      if (result.status !== "confirmed" || !Array.isArray(result.data.notifications) || active.aborted) break;
      const matching = result.data.notifications.filter((row: unknown): row is Record<string, unknown> =>
        record(row) && row.group_id === origin.groupId && row.notification_seq === origin.sequence);
      if (matching.length > 1) break;
      const found = matching[0];
      if (found) {
        if (found.type !== origin.kind || (origin.kind === "join_request" ? found.initiator_id !== origin.userId :
          found.target_user_id !== origin.userId || found.initiator_id !== origin.inviterId)) break;
        if (found.is_filtered === true) return "risk" as const;
        if (origin.kind === "join_request" && found.is_filtered !== false) break;
        if (found.state === "pending") return "pending" as const;
        if (found.state === "accepted" || found.state === "rejected" || found.state === "ignored") return "expired" as const;
        break;
      }
      const next = result.data.next_notification_seq;
      if (!positiveId(next) || visited.has(next)) break;
      visited.add(next);
      start_notification_seq = next;
    }
    return "unavailable" as const;
  }

  async function readPendingGroupJoins(groupId: number, active: AbortSignal) {
    async function readPages(is_filtered: boolean) {
      const entries = new Map<string, MilkyPendingJoin>();
      const conflicted = new Set<string>();
      const visited = new Set<number>();
      let start_notification_seq: number | undefined;
      let received = false;
      let wellFormed = true;
      let complete = false;
      for (let page = 0; page < 8 && !active.aborted; page++) {
        const result = await call.confirmed("get_group_notifications", { is_filtered, limit: 50,
          ...(start_notification_seq === undefined ? {} : { start_notification_seq }) }, active);
        if (result.status !== "confirmed" || !Array.isArray(result.data.notifications) || active.aborted) break;
        received = true;
        for (const row of result.data.notifications) {
          if (!record(row) || !positiveId(row.group_id)) { wellFormed = false; continue; }
          if (row.group_id !== groupId || (row.type !== "join_request" && row.type !== "invited_join_request")) continue;
          if (row.state !== "pending") {
            if (row.state !== "accepted" && row.state !== "rejected" && row.state !== "ignored") wellFormed = false;
            continue;
          }
          const direct = row.type === "join_request";
          const userId = direct ? row.initiator_id : row.target_user_id;
          if (!positiveId(userId) || !positiveId(row.initiator_id) || !positiveId(row.notification_seq) || (direct && row.is_filtered !== is_filtered)) {
            wellFormed = false;
            continue;
          }
          const key = `${row.type}:${row.notification_seq}`;
          if (conflicted.has(key)) continue;
          const previous = entries.get(key);
          if (previous && previous.userId !== userId) {
            conflicted.add(key);
            entries.delete(key);
            wellFormed = false;
          } else if (!previous) {
            const filtered = direct && is_filtered;
            entries.set(key, { userId, risk: is_filtered, comment: direct && typeof row.comment === "string" ? row.comment : undefined,
              origin: { adapter: "milky", botId: account, groupId, userId, sequence: row.notification_seq, kind: row.type,
                filtered, inviterId: direct ? undefined : row.initiator_id,
                flag: milkyGroupRequestFlag(account, `group_${row.type}`, groupId, row.notification_seq, filtered) },
            });
          }
        }
        const next = result.data.next_notification_seq;
        if (next === undefined || next === null) { complete = wellFormed; break; }
        if (!positiveId(next) || visited.has(next)) break;
        visited.add(next);
        start_notification_seq = next;
      }
      return received ? { entries, conflicted, complete } : undefined;
    }

    const [normal, filtered] = await Promise.all([readPages(false), readPages(true)]);
    if (active.aborted || (!normal && !filtered)) return;
    const entries = new Map(normal?.entries);
    const conflicted = new Set([...(normal?.conflicted ?? []), ...(filtered?.conflicted ?? [])]);
    for (const [key, row] of filtered?.entries ?? []) {
      const previous = entries.get(key);
      if (previous && previous.userId !== row.userId) conflicted.add(key);
      else entries.set(key, previous ? { ...previous, risk: true } : row);
    }
    for (const key of conflicted) entries.delete(key);
    return { entries: [...entries.values()], complete: !conflicted.size && normal?.complete === true && filtered?.complete === true };
  }

  async function submitGroupJoin(origin: MilkyJoinOrigin, approve: boolean, active: AbortSignal) {
    return (await call.confirmed(approve ? "accept_group_request" : "reject_group_request", {
      group_id: origin.groupId, notification_seq: origin.sequence, notification_type: origin.kind, is_filtered: origin.filtered,
    }, active)).status;
  }

  function groupJoinAuthority(groupId: number, actor: number, combined: AbortSignal) {
    const active = () => !combined.aborted && options.canModerateGroups?.() !== false;
    const authorized = () => groupOperatorAuthority(id => memberRole(groupId, id, combined), account, actor, () => isMaster(actor), active);
    return { active, authorized };
  }

  async function reviewExactGroupJoin(origin: MilkyJoinOrigin, approve: boolean, combined: AbortSignal,
    authority: ReturnType<typeof groupJoinAuthority>) {
    if (!joinReview || !authority.active() || origin.userId === account) return "unavailable" as const;
    const pending = await verifyPendingGroupJoin(origin, combined);
    if (pending !== "pending") return pending;
    return joinReview.once(origin, async () => {
      if (!await authority.authorized() || !authority.active()) return "unavailable";
      return submitGroupJoin(origin, approve, combined);
    });
  }

  async function reviewPendingGroupJoin(groupId: number, actor: number, user: number, approve: boolean,
    combined: AbortSignal): Promise<PendingGroupJoinDecision> {
    if (!joinReview || !positiveId(user) || user === account || typeof approve !== "boolean") return { status: "unavailable" };
    const authority = groupJoinAuthority(groupId, actor, combined);
    if (!await authority.authorized()) return { status: "unavailable" };
    const list = await readPendingGroupJoins(groupId, combined);
    if (!authority.active() || !list?.complete) return { status: "unavailable" };
    const matches = list.entries.filter(entry => entry.userId === user);
    if (!matches.length) return { status: "not-found" };
    if (matches.some(entry => entry.risk)) return { status: "risk" };
    const [selected] = matches;
    if (matches.length !== 1 || !selected) return { status: "ambiguous" };
    const status = await reviewExactGroupJoin(selected.origin, approve, combined, authority);
    return { status, nickname: selected.nickname };
  }

  async function reviewAllPendingGroupJoins(groupId: number, actor: number, approve: boolean,
    combined: AbortSignal): Promise<PendingGroupJoinBatch> {
    if (!joinReview || typeof approve !== "boolean") return { status: "unavailable" };
    const authority = groupJoinAuthority(groupId, actor, combined);
    if (!await authority.authorized()) return { status: "unavailable" };
    const list = await readPendingGroupJoins(groupId, combined);
    if (!authority.active() || !list?.complete) return { status: "unavailable" };
    if (!list.entries.length) return { status: "not-found" };
    const entries: NonNullable<PendingGroupJoinBatch["entries"]>[number][] = [];
    let continuing = true;
    for (const entry of list.entries) {
      if (entry.risk) { entries.push({ userId: entry.userId, status: "risk" }); continue; }
      continuing = continuing && authority.active() && !!await authority.authorized();
      const status = continuing ? await reviewExactGroupJoin(entry.origin, approve, combined, authority) : "unavailable";
      entries.push({ userId: entry.userId, status });
    }
    return { status: "processed", entries };
  }

  async function memberRole(group_id: number, user_id: number, active = signal) {
    return (await liveGroupMember(group_id, user_id, active))?.role;
  }

  async function liveGroupMember(group_id: number, user_id: number, active = signal): Promise<LiveGroupMember | undefined> {
    if (signal.aborted || active.aborted) return;
    const result = await call.confirmed("get_group_member_info", { group_id, user_id, no_cache: true }, active);
    const member = result.status === "confirmed" ? result.data.member : undefined;
    if (signal.aborted || active.aborted || !record(member) || member.group_id !== group_id || member.user_id !== user_id) return;
    if (member.role === "member" || member.role === "admin" || member.role === "owner") {
      const last = member.last_sent_time;
      const card = memberDisplayName(member.card);
      const nickname = memberDisplayName(member.nickname);
      return { role: member.role, name: card || nickname, nickname, card,
        joinTime: positiveId(member.join_time) ? member.join_time : undefined,
        lastSentTime: typeof last === "number" && Number.isSafeInteger(last) && last >= 0 ? last : undefined };
    }
  }

  async function listGroupAnnouncements(group_id: number) {
    const result = await call.confirmed("get_group_announcements", { group_id }, signal);
    if (result.status !== "confirmed" || signal.aborted) return;
    return readGroupAnnouncements(result.data.announcements, row => {
      if (!record(row) || row.group_id !== group_id || typeof row.announcement_id !== "string" || typeof row.content !== "string") return;
      return { id: row.announcement_id, text: row.content };
    });
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
    memberRole,
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

  const noticeAccount: NoticeGroupAccount = {
    botId: account, adapter: "milky",
    async listGroups(active = signal) {
      const result = await call.confirmed("get_group_list", { no_cache: true }, active);
      const groups = result.status === "confirmed" ? result.data.groups : undefined;
      if (signal.aborted || active.aborted || !Array.isArray(groups)) throw new Error("公告群列表未确认。");
      return groups.map(group => {
        if (!record(group) || !positiveId(group.group_id)) throw new Error("公告群列表无效。");
        return { id: group.group_id, name: typeof group.group_name === "string" ? group.group_name : undefined };
      });
    },
    async sendGroup(group_id, message, active = signal) {
      if (active.aborted || signal.aborted || options.accepting?.() === false) throw new NoticeNotSentError("原公告会话已关闭。");
      let messageId: number | undefined;
      const attempt = sendConfirmed({ group_id }, message, undefined, signal, id => { messageId = id; });
      options.onNoticeAttempt?.(attempt);
      const status = await attempt;
      if (status === "rejected") throw new NoticeNotSentError("公告未发出。");
      if (messageId === undefined) throw new Error("公告发送结果未确认。");
      return messageId;
    },
    async recall(group_id, message_seq, active = signal) {
      if (!positiveId(group_id) || !hasMessageSequence(message_seq) || active.aborted || signal.aborted ||
          options.accepting?.() === false) throw new NoticeNotSentError("公告撤回参数或会话无效。");
      const attempt = call.confirmed("recall_group_message", { group_id, message_seq });
      options.onNoticeAttempt?.(attempt);
      const result = await attempt;
      if (result.status === "rejected") throw new NoticeNotSentError("公告撤回未执行。");
      if (result.status !== "confirmed") throw new Error("公告撤回结果未确认。");
    },
  };

  return { botId: account, checkinNotify, ownGroupCardAccount: bindCard(), noticeAccount, async timedWholeMute(binding, jobSignal) {
    if (binding.adapter !== "milky" || binding.botId !== account) return "unavailable";
    const active = AbortSignal.any([signal, jobSignal]);
    return runTimedWholeMute(binding, {
      active: () => !active.aborted,
      role: id => memberRole(binding.groupId, id, active),
      isMaster: () => isMaster(binding.issuerId),
      async write(is_mute) {
        return (await call.confirmed("set_group_whole_mute", { group_id: binding.groupId, is_mute }, active)).status;
      },
    });
  }, async send(target, reply) {
    return await sendConfirmed(target, reply) === "confirmed";
  }, receive(body) {
    if (signal.aborted) return "offline";
    if (!record(body) || !positiveId(body.self_id) || typeof body.event_type !== "string" ||
        !body.event_type || !record(body.data)) return "invalid";
    if (body.self_id !== account) return "foreign";
    if (body.event_type === "bot_offline") return "offline";
    if (options.accepting?.() === false) return "accepted";
    groupMute.observe(body);

    if (body.event_type === "group_admin_change") {
      const { group_id, user_id, is_set } = body.data;
      if (options.onGroupOwnerAdminNotice && positiveId(group_id) && positiveId(user_id) && typeof is_set === "boolean" && positiveId(body.time)) {
        options.onGroupOwnerAdminNotice({ adapter: "milky", botId: account, groupId: group_id, userId: user_id, set: is_set, time: body.time, signal,
          notifyOwners: notifyVerifiedOwnerReplies,
        });
      }
      return "accepted";
    }

    if (body.event_type === "group_disband") {
      const { group_id, operator_id } = body.data;
      if (positiveId(group_id) && positiveId(body.time)) {
        options.onGroupOwnerGroupNotice?.({ adapter: "milky", botId: account, groupId: group_id, time: body.time, kind: "dissolved", signal,
          operatorId: positiveId(operator_id) ? operator_id : undefined,
          describe: active => readVerifiedGroupName(group_id, active), notifyOwners: notifyVerifiedOwnerReplies,
        });
      }
      return "accepted";
    }

    if (body.event_type === "friend_file_upload") {
      const upload = milkyFriendFileUpload(body, account, async (action, params) => {
        return confirmSent(upload, await call(action, params), params.message);
      }, call.confirmed);
      if (upload) files.upload(upload);
      return "accepted";
    }

    if (body.event_type === "message_recall" && body.data.message_scene === "friend") {
      const { sender_id, peer_id, operator_id, message_seq } = body.data;
      if (options.onFriendRecall && positiveId(sender_id) && sender_id === peer_id && sender_id === operator_id && sender_id !== account &&
          positiveId(body.time) && hasMessageSequence(message_seq)) {
        options.onFriendRecall({ adapter: "milky", botId: account, userId: sender_id, messageId: message_seq, time: body.time, signal,
          notifyOwners: (reply, workflow, followup) => notifyVerifiedOwnerReplies(reply, workflow, followup,
            followup === undefined ? undefined : sender_id),
        });
      }
      return "accepted";
    }

    if (body.event_type === "message_recall" && body.data.message_scene === "group") {
      const { sender_id, peer_id, operator_id, message_seq } = body.data;
      if (options.onGroupRecall && positiveId(sender_id) && positiveId(peer_id) && positiveId(operator_id) &&
          sender_id !== account && operator_id !== account && positiveId(body.time) && hasMessageSequence(message_seq)) {
        options.onGroupRecall({ adapter: "milky", botId: account, userId: sender_id, groupId: peer_id,
          operatorId: operator_id, messageId: message_seq, time: body.time, signal,
          async describe(active) {
            const [response, author, operator] = await Promise.all([
              call.confirmed("get_group_info", { group_id: peer_id, no_cache: true }, active),
              liveGroupMember(peer_id, sender_id, active),
              operator_id === sender_id ? undefined : liveGroupMember(peer_id, operator_id, active),
            ]);
            const group = response.status === "confirmed" ? response.data.group : undefined;
            const groupName = record(group) && group.group_id === peer_id ? memberDisplayName(group.group_name) : undefined;
            return { groupName, nickname: author?.name, operatorName: operator?.name };
          },
          async notifyOwners(summary, original, nickname, active, followup) {
            if (followup !== undefined) {
              await notifyVerifiedOwnerReplies(summary, active, followup);
              return;
            }
            const messages = encodeMilkyForward([original], sender_id, nickname ?? String(sender_id));
            if (active.aborted || !messages) return;
            const friends = await listCurrentFriends(active);
            const owners = (await selectNoticeOwners(active)).filter(owner => friends?.has(owner));
            await Promise.all(owners.map(async owner => {
              if (active.aborted || !isMaster(owner)) return;
              const target = { user_id: owner };
              if (await sendConfirmed(target, summary, undefined, active) !== "confirmed" || active.aborted || !isMaster(owner)) return;
              const message = [{ type: "forward", data: { messages } }];
              const result = await call.confirmed("send_private_message", { ...target, message }, active);
              if (result.status === "confirmed") confirmSent(target, result.data, message);
              if (result.status === "rejected" && !active.aborted && isMaster(owner)) {
                await sendConfirmed(target, typeof original === "string" ? `撤回消息：${original}` : ["撤回消息：", ...original], undefined, active);
              }
            }));
          },
        });
      }
      return "accepted";
    }

    if (body.event_type === "message_receive" && body.data.message_scene === "temp") {
      const { sender_id, peer_id, message_seq, group, segments } = body.data;
      if (options.onTemporaryMessage && positiveId(sender_id) && sender_id === peer_id && sender_id !== account &&
          hasMessageSequence(message_seq)) {
        const message = decodeMilkyTemporaryMessage(segments, account, sender_id, call);
        const groupId = record(group) && positiveId(group.group_id) ? group.group_id : undefined;
        if (message) {
          options.onTemporaryMessage({ adapter: "milky", botId: account, userId: sender_id, messageId: message_seq, message, groupId, signal,
            notifyOwners: notifyVerifiedOwnerReplies,
          });
        }
      }
      return "accepted";
    }

    const message = milkyMessage(body, account, async (action, params) => {
      return confirmSent(message, await call(action, params), params.message);
    }, scheduleRecall, async (action, params) => {
      const result = await call.confirmed(action, params);
      if (result.status === "unknown") throw new Error("Milky 转发回执未确认。");
      if (result.status === "confirmed") return confirmSent(message, result.data, params.message);
    }, call.confirmed);
    if (message?.message_type === "group" && positiveId(message.group_id) && positiveId(message.user_id) && hasMessageSequence(message.message_id)) {
      const groupId = message.group_id;
      options.onGroupMessageSource?.({ adapter: "milky", botId: account, groupId, userId: message.user_id,
        messageId: message.message_id, message: message.message,
        nickname: typeof message.sender?.nickname === "string" ? message.sender.nickname : undefined, signal,
        describeGroup: active => readVerifiedGroupName(groupId, active), notifyOwners: notifyVerifiedOwnerReplies,
      });
    }
    if (message && !files.receive(message)) return "accepted";
    async function sendReply(target: { group_id: number } | { user_id: number }, reply: MessageReply,
      onDelivered?: ReplyOptions["onDelivered"], active = signal) {
      const content = encodeMilkyReply(reply);
      if (!content) return false;
      const action = "group_id" in target ? "send_group_message" : "send_private_message";
      const result = await call.confirmed(action, { ...target, message: content }, active);
      if (result.status === "rejected") return false;
      if (result.status === "unknown" || !hasMessageSequence(result.data.message_seq)) {
        throw new Error("Milky 通知回复未确认。");
      }
      confirmSent(target, result.data, content);
      await notifyReplyDelivery(onDelivered, result.data.message_seq);
      return true;
    }

    if (body.event_type === "group_mute" && (options.onMemberMute || options.onGroupOwnerBanNotice)) {
      const { time } = body;
      const { group_id, user_id, operator_id, duration } = body.data;
      if (positiveId(group_id) && positiveId(user_id) && positiveId(operator_id) && positiveId(time) &&
          isMemberMuteDuration(duration)) {
        if (user_id === account) {
          options.onGroupOwnerBanNotice?.({ adapter: "milky", botId: account, groupId: group_id, userId: user_id,
            operatorId: operator_id, time, duration, signal, notifyOwners: notifyVerifiedOwnerReplies,
          });
        }
        options.onMemberMute?.({ self_id: account, group_id, user_id, operator_id, time, duration, signal,
          canModerate: active => canModerateGroupSubject(id => memberRole(group_id, id, active), account, user_id),
          async unmute(active) {
            return (await call.confirmed("set_group_member_mute", { group_id, user_id, duration: 0 }, active)).status;
          },
          reply: reply => sendReply({ group_id }, reply),
        });
      }
      return "accepted";
    }

    const incomingFriend = body.event_type === "friend_request"
      ? milkyFriendRequest(body, account, approveFriendRequest, (user_id, reply) => sendReply({ user_id }, reply), options.masterIds?.(account) ?? [])
      : undefined;
    const friendRequest = incomingFriend && { ...incomingFriend, approvalSignal: signal, notifyOwners: notifyOwnerReplies };
    let groupRequest;
    if (body.event_type === "group_invitation" || body.event_type === "group_join_request" || body.event_type === "group_invited_join_request") {
      const kind = body.event_type === "group_invitation" ? "invite" : "add";
      const candidate = milkyGroupRequest(body, account, {
        isMaster,
        approve: (flag, accept, reason) => submitGroupRequest(flag, kind, accept, reason),
        sendGroup: (group_id, reply, onDelivered) => sendReply({ group_id }, reply, onDelivered),
        sendPrivate: (user_id, reply) => sendReply({ user_id }, reply),
        masterIds: options.masterIds?.(account) ?? [],
      });
      if (candidate) {
        const { decision, joinRequestOrigin, invitationOrigin, ...request } = candidate;
        if (groupReviews.register(request, decision)) {
          groupRequest = invitationReceipts && invitationOrigin ? {
            ...request,
            notifyOwners: notifyVerifiedOwnerReplies,
            async notifyRequestOwners(message: string, rich?: { readonly reply: MessageReply; readonly signal: AbortSignal }) {
              const workflow = options.groupWorkflowSignal?.();
              const active = AbortSignal.any([signal, ...(workflow ? [workflow] : []), ...(rich ? [rich.signal] : [])]);
              const friends = rich && await listCurrentFriends(active);
              if (active.aborted || (rich && !friends)) return 0;
              const candidates = rich ? await selectNoticeOwners(active) : options.masterIds?.(account) ?? [];
              const owners = candidates.filter(owner => owner !== account && isMaster(owner) && (!friends || friends.has(owner)));
              const origin = rich ? { ...invitationOrigin, groupAvatar: true as const } : invitationOrigin;
              const delivered = await Promise.allSettled(owners.map(owner => sendReply({ user_id: owner }, rich?.reply ?? message, async (messageId) => {
                if (!active.aborted && isMaster(owner)) await invitationReceipts.record({ account, owner, message: messageId }, origin, message);
              }, active)));
              return delivered.filter(outcome => outcome.status === "fulfilled" && outcome.value).length;
            },
          } : { ...request, notifyOwners: notifyVerifiedOwnerReplies };
          if (kind === "add") bindGroupModeration(groupRequest, {
            signal,
            joinRequestOrigin,
            canModerate: () => canModerateGroupSubject(id => delegation.memberRole(request.group_id, id), account),
            async act(active, reason = "主动退群被拉黑") {
              if (active.aborted || signal.aborted) return "rejected";
              try {
                return await confirmJoinReview(joinReview, { adapter: "milky", botId: account, flag: request.flag },
                  () => groupReviews.review(account, request.flag, kind, false, reason,
                    (action, params) => call.confirmed(action, params, active))) ? "confirmed" : "rejected";
              } catch {
                return "unknown";
              }
            },
          });
          else bindGroupModeration(groupRequest, { signal });
        }
      }
    }
    const canReview = message?.isPrivate === true && positiveId(message.user_id) && isMaster(message.user_id);
    const groupId = message?.isGroup ? message.group_id : undefined;
    const mentioned = message && positiveId(groupId) && positiveId(message.user_id)
      ? mentionedProfileId(message.message, account, message.user_id) : undefined;
    const listCurrentGroupMembers = positiveId(groupId) ? () => listGroupMembers(groupId) : undefined;
    const cardOwner = message?.user_id;
    const quoted = typeof message?.reply_id === "string" ? Number(message.reply_id) : message?.reply_id;
    const lookupReply = message?.lookupReply;
    const workflowSignal = positiveId(groupId) && !message?.attachmentOnly ? options.groupWorkflowSignal?.() : undefined;
    const privateGroupSignal = canReview && message?.sub_type === "friend" && !message.attachmentOnly ? options.groupWorkflowSignal?.() : undefined;
    const ownerSignal = privateGroupSignal && AbortSignal.any([signal, privateGroupSignal]);
    const { friendNoticeReceipts, ownerFriendReplyClaim } = options;
    const ownerMessageId = message?.message_id;
    const ownerFriendReply = ownerSignal && message && positiveId(cardOwner) ? bindOwnerFriendReply({
      account, signal: ownerSignal, isOwner: () => isMaster(cardOwner), source: message.message,
      claimDelivery: ownerFriendReplyClaim && hasMessageSequence(ownerMessageId) ? sendReply => ownerFriendReplyClaim({
        adapter: "milky", botId: account, flag: `${cardOwner}:${ownerMessageId}`,
      }, sendReply) : undefined,
      async isFriend(userId, active) { return (await listCurrentFriends(active))?.has(userId); },
      send: (user_id, reply, active) => sendConfirmed({ user_id }, reply, undefined, active),
    }) : undefined;
    const scopedMessage = message && {
      ...message, adapter: "milky" as const, groupRequestScope: "milky" as const, canReviewGroupRequests: canReview,
      [delegationSession]: delegation,
      [friendMessageNoticeSession]: message.sub_type === "friend" && !message.attachmentOnly ? {
        signal,
        async notifyOwners(reply, workflow, onDelivered, delivery) {
          const active = AbortSignal.any([signal, workflow]);
          const friends = delivery?.verifyRecipients ? await listCurrentFriends(active) : undefined;
          if (active.aborted || (delivery?.verifyRecipients && !friends)) return 0;
          return notifyOwnerReplies(reply, active, onDelivered, friends, delivery?.followup);
        },
      } satisfies FriendMessageNoticeSession : undefined,
      listPendingGroupInvitations: privateGroupSignal && positiveId(cardOwner) ? async () => {
        if (!signal.aborted && !privateGroupSignal.aborted && isMaster(cardOwner)) return groupReviews.listObservedInvitations(account);
      } : undefined,
      reviewPendingGroupInvitation: privateGroupSignal && positiveId(cardOwner) ? (group: number, approve: boolean) =>
        reviewCurrentGroupInvitation(cardOwner, group, approve, AbortSignal.any([signal, privateGroupSignal])) : undefined,
      reviewQuotedGroupInvitation: invitationReceipts && privateGroupSignal && lookupReply && hasMessageSequence(quoted) && positiveId(cardOwner)
        ? (approve: boolean) => reviewQuotedGroupInvitation(cardOwner, quoted, approve,
          AbortSignal.any([signal, privateGroupSignal]), lookupReply) : undefined,
      listPendingFriendRequests: privateGroupSignal && positiveId(cardOwner) ? async () => {
        const combined = AbortSignal.any([signal, privateGroupSignal]);
        const active = () => !combined.aborted && isMaster(cardOwner);
        if (!active()) return;
        const [ordinary, filtered] = await readFriendRequestWindows(combined);
        if (active()) return milkyPendingFriendRequests(account, ordinary, filtered);
      } : undefined,
      reviewPendingFriendRequest: privateGroupSignal && positiveId(cardOwner) ? (user: number, approve: boolean) =>
        reviewCurrentFriendRequest(cardOwner, user, approve, AbortSignal.any([signal, privateGroupSignal])) : undefined,
      sendOwnerFriendReply: ownerFriendReply,
      sendQuotedOwnerFriendReply: friendNoticeReceipts && ownerSignal && ownerFriendReply && positiveId(cardOwner) && lookupReply && hasMessageSequence(quoted)
        ? bindQuotedOwnerFriendReply(friendNoticeReceipts, { adapter: "milky", account, owner: cardOwner, message: quoted },
          () => !ownerSignal.aborted && isMaster(cardOwner), lookupReply, ownerFriendReply) : undefined,
      ...(privateGroupSignal && positiveId(cardOwner) && options.canModeratePrivateGroup &&
        bindPrivateGroupActions({ bot: account, signal: AbortSignal.any([signal, privateGroupSignal]),
          master: () => isMaster(cardOwner), protectedMember: id => options.isProtectedMaster?.(account, id) ?? isMaster(id),
          allowed: groupId => options.canModeratePrivateGroup?.(account, groupId) === true,
          member: liveGroupMember,
          async mute(group_id, user_id, duration, active) {
            return (await call.confirmed("set_group_member_mute", { group_id, user_id, duration }, active)).status;
          },
          async kick(group_id, user_id, active) {
            return (await call.confirmed("kick_group_member", { group_id, user_id, reject_add_request: false }, active)).status;
          },
          async wholeMute(group_id, is_mute, active) {
            return (await call.confirmed("set_group_whole_mute", { group_id, is_mute }, active)).status;
          },
          async groupName(group_id, active) {
            const result = await call.confirmed("get_group_info", { group_id, no_cache: true }, active);
            const group = result.status === "confirmed" ? result.data.group : undefined;
            if (record(group) && group.group_id === group_id && typeof group.group_name === "string") return group.group_name;
          },
        })),
      groupActivityRoster: positiveId(groupId) && positiveId(cardOwner)
        ? (visibility: GroupActivityVisibility | undefined) => listGroupActivity(groupId, cardOwner, visibility) : undefined,
      groupActivitySignal: positiveId(groupId) ? signal : undefined,
      groupVerification: workflowSignal && positiveId(groupId) && positiveId(cardOwner)
        ? bindGroupVerificationScope({ connection: signal, workflow: workflowSignal,
          botId: account, groupId, actorId: cardOwner, accepting: () => options.canModerateGroups?.() !== false,
          isMaster: () => isMaster(cardOwner), isProtected: id => options.isProtectedMaster?.(account, id) ?? isMaster(id),
          transport: {
            adapter: "milky",
            member: (id, active) => liveGroupMember(groupId, id, active),
            async send(reply, active) { return await sendConfirmed({ group_id: groupId }, reply, undefined, active) === "confirmed"; },
          },
          async kick(user_id, active) {
            return (await call.confirmed("kick_group_member", { group_id: groupId, user_id }, active)).status;
          },
        }) : undefined,
      groupRuleImageDigest: positiveId(groupId) && positiveId(cardOwner)
        ? bindGroupRuleImageDigest(message.message, account, signal, options.canModerateGroups, active => memberRole(groupId, cardOwner, active))
        : undefined,
      groupListAnnouncements: positiveId(groupId) && positiveId(cardOwner) ? async () => {
        const active = () => !signal.aborted && options.canModerateGroups?.() !== false;
        if (!active() || !await memberRole(groupId, cardOwner) || !active()) return;
        const announcements = await listGroupAnnouncements(groupId);
        if (announcements && active() && await memberRole(groupId, cardOwner) && active()) return announcements;
      } : undefined,
      groupListPendingJoinRequests: workflowSignal && positiveId(groupId) && positiveId(cardOwner) ? async () => {
        const combined = AbortSignal.any([workflowSignal, signal]);
        const active = () => !combined.aborted && options.canModerateGroups?.() !== false;
        const authorize = () => groupMayReadPendingJoins(id => memberRole(groupId, id, combined), account, cardOwner, active);
        if (!await authorize()) return;
        const list = await readPendingGroupJoins(groupId, combined);
        if (list && await authorize()) return { complete: list.complete, entries: list.entries.map(({ origin, ...entry }) => entry) };
      } : undefined,
      groupReviewPendingJoin: workflowSignal && joinReview && positiveId(groupId) && positiveId(cardOwner)
        ? (userId: number, approve: boolean) => reviewPendingGroupJoin(groupId, cardOwner, userId, approve, AbortSignal.any([workflowSignal, signal]))
        : undefined,
      groupReviewAllPendingJoins: workflowSignal && joinReview && positiveId(groupId) && positiveId(cardOwner)
        ? (approve: boolean) => reviewAllPendingGroupJoins(groupId, cardOwner, approve, AbortSignal.any([workflowSignal, signal]))
        : undefined,
      groupReviewQuotedRequest: joinReview && lookupReply && hasMessageSequence(quoted) && positiveId(groupId) && positiveId(cardOwner)
        ? (approve: boolean) => {
          const active = () => !signal.aborted && options.canModerateGroups?.() !== false;
          return joinReview.quoted({ adapter: "milky", botId: account, groupId, messageId: quoted }, {
            active,
            async verifyNotice() { return (await lookupReply())?.user_id === account; },
            async authorize() {
              return await groupOperatorAuthority(id => memberRole(groupId, id), account, cardOwner,
                () => isMaster(cardOwner), active) !== undefined;
            },
            verifyPending: origin => origin.adapter === "milky" ? verifyPendingGroupJoin(origin) : Promise.resolve("unavailable"),
            submit: origin => origin.adapter === "milky" ? submitGroupJoin(origin, approve, signal) : Promise.resolve("unavailable"),
          });
        } : undefined,
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
        async role(id, onName) {
          const member = await liveGroupMember(groupId, id);
          if (member?.name) onName?.(member.name);
          return member?.role;
        },
        async mute(user_id, duration, active = signal) {
          return (await call.confirmed("set_group_member_mute", { group_id: groupId, user_id, duration }, active)).status;
        },
        async wholeMute(is_mute) {
          return (await call.confirmed("set_group_whole_mute", { group_id: groupId, is_mute }, signal)).status;
        },
        async kick(user_id, reject_add_request, active = signal) {
          return (await call.confirmed("kick_group_member", { group_id: groupId, user_id, reject_add_request }, active)).status;
        },
        async title(user_id, special_title) {
          return (await call.confirmed("set_group_member_special_title", { group_id: groupId, user_id, special_title }, signal)).status;
        },
        async setAdmin(user_id, is_set) {
          return (await call.confirmed("set_group_member_admin", { group_id: groupId, user_id, is_set }, signal)).status;
        },
        essence: lookupReply && hasMessageSequence(quoted) ? {
          async verifyQuote() { return await lookupReply() !== undefined; },
          async write(is_set) {
            return (await call.confirmed("set_group_essence_message", { group_id: groupId, message_seq: quoted, is_set }, signal)).status;
          },
        } : undefined,
        notice: {
          source: message.message,
          send: reply => sendConfirmed({ group_id: groupId }, reply),
        },
        announcement: {
          source: message.message,
          list: () => listGroupAnnouncements(groupId),
          async send(content, image_uri) {
            return (await call.confirmed("send_group_announcement", {
              group_id: groupId, content, ...(image_uri === undefined ? {} : { image_uri }),
            }, signal)).status;
          },
          async remove(announcement_id) {
            return (await call.confirmed("delete_group_announcement", { group_id: groupId, announcement_id }, signal)).status;
          },
        },
        vote: workflowSignal ? {
          signal: workflowSignal,
          async reply(parts, quote, active) {
            return await sendConfirmed({ group_id: groupId }, parts, quote ? message.message_id : undefined, active) === "confirmed";
          },
        } : undefined,
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
      reviewGroupRequest: privateGroupSignal && positiveId(cardOwner)
        ? (flag: string, kind: "add" | "invite", accept: boolean, reason?: string) => submitGroupRequest(flag, kind, accept, reason,
          AbortSignal.any([signal, privateGroupSignal]), () => isMaster(cardOwner)) : undefined,
    };
    const event = scopedMessage ?? friendRequest ?? groupRequest ?? milkyNotice(body, account, call, sendReply, async (group_id) => {
      const result = await call.confirmed("quit_group", { group_id });
      if (result.status === "unknown") throw new Error("Milky 退群回执未确认。");
      return result.status === "confirmed";
    });
    if (event?.post_type === "notice" && event.notice_type === "group" && event.sub_type !== "poke") {
      const { group_id, user_id } = event;
      if (user_id === account && event.dismiss !== true && positiveId(event.time)) {
        const operatorId = event.operator_id === account ? undefined : event.operator_id;
        const kind = event.sub_type === "increase" ? "joined" : operatorId !== undefined ? "removed" : "departed";
        options.onGroupOwnerGroupNotice?.({ adapter: "milky", botId: account, groupId: group_id, time: event.time, kind, operatorId, signal,
          describe: active => readVerifiedGroupName(group_id, active), notifyOwners: notifyVerifiedOwnerReplies,
        });
      }
      if (user_id !== account && event.dismiss !== true) {
        options.onGroupOwnerMemberNotice?.({ adapter: "milky", event, signal,
          async describe(active) {
            const [groupName, member] = await Promise.all([
              readVerifiedGroupName(group_id, active),
              event.sub_type === "increase" ? liveGroupMember(group_id, user_id, active) : undefined,
            ]);
            return { groupName, nickname: member?.nickname, card: member?.card };
          },
          notifyOwners: notifyVerifiedOwnerReplies,
        });
      }
      bindGroupModeration(event, {
        signal,
        groupVerification: {
          adapter: "milky",
          member: (user, active) => liveGroupMember(group_id, user, active),
          async send(reply, active) { return await sendConfirmed({ group_id }, reply, undefined, active) === "confirmed"; },
        },
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
