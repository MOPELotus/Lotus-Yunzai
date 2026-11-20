import type { CheckinNotifyDelivery, CheckinNotifyTransport } from "../checkin-notify.ts";
import { delegationSession, type DelegationSession } from "../command-delegation.ts";
import { notifyReplyDelivery, type BotEvent, type MessageReply, type ReplyOptions } from "../messages.ts";
import { confirmJoinReview, type JoinRequestOrigin, type PendingGroupJoinDecision, type PendingGroupJoinEntry } from "../group-join-review.ts";
import { bindGroupCard } from "./group-card.ts";
import { bindGroupModeration, bindGroupRuleImageDigest, bindGroupVerificationScope, bindMessageGroupActions, bindMixedGroupImageParts,
  bindPrivateGroupActions, bindSingleGroupImageDigest, canModerateGroupSubject,
  groupMayReadPendingJoins, groupOperatorAuthority, isMemberMuteDuration, readGroupActivity, readGroupAnnouncements,
  runTimedWholeMute, type GroupActionPolicy, type GroupActivityVisibility, type LiveGroupMember, type TimedGroupMuteBinding,
  type TimedGroupMuteResult } from "./group-moderation.ts";
import { bindMentionLike, mentionedProfileId } from "./mention-like.ts";
import { createMilkyApi } from "./milky-api.ts";
import type { MilkySettings } from "./milky-config.ts";
import { milkyFriendRequest } from "./milky-friend-request.ts";
import { milkyGroupRequest, milkyGroupRequestFlag } from "./milky-group-request.ts";
import { createMilkyGroupReviews } from "./milky-group-reviews.ts";
import { createMilkyGroupMute } from "./milky-group-mute.ts";
import { createMilkyFileDelivery } from "./milky-file-delivery.ts";
import { encodeMilkyForward, encodeMilkyReply, milkyFriendFileUpload, milkyMessage } from "./milky-message.ts";
import { milkyNotice } from "./milky-notice.ts";
import { createMilkyRecallReply } from "./milky-recall-reply.ts";
import { memberDisplayName } from "./onebot-member-display.ts";
import { bindOwnGroupCard, ownGroupCardSession, type OwnGroupCardAccount } from "./own-group-card.ts";

type MessageRecipient = { readonly group_id?: number; readonly user_id?: number };
type MilkyJoinOrigin = Extract<JoinRequestOrigin, { adapter: "milky" }>;
type MilkyPendingJoin = PendingGroupJoinEntry & { readonly origin: MilkyJoinOrigin };

export interface MilkyTransportOptions extends GroupActionPolicy {
  readonly signal: AbortSignal;
  readonly dispatch: (event: BotEvent) => Promise<void>;
  readonly onSent?: (identity: MessageRecipient & { readonly self_id: number }, message: unknown) => void;
  readonly masterIds?: (botId: number) => readonly number[];
  readonly onOnline?: (botId: number, signal: AbortSignal, send: MilkySession["send"], checkinNotify: CheckinNotifyTransport,
    ownGroupCardAccount: OwnGroupCardAccount, timedWholeMute: MilkySession["timedWholeMute"]) => void;
  readonly isMaster?: (botId: number, userId: number) => boolean;
  readonly groupReviews?: ReturnType<typeof createMilkyGroupReviews>;
}

export interface MilkySession {
  readonly botId: number;
  readonly checkinNotify: CheckinNotifyTransport;
  readonly ownGroupCardAccount: OwnGroupCardAccount;
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

  async function sendConfirmed(target: { group_id: number } | { user_id: number }, reply: MessageReply, quoted?: number,
    active = signal): Promise<CheckinNotifyDelivery> {
    const group = "group_id" in target;
    if (signal.aborted || active.aborted || !positiveId(group ? target.group_id : target.user_id)) return "rejected";
    const message = encodeMilkyReply(reply, quoted);
    if (!message) return "rejected";
    const result = await call.confirmed(group ? "send_group_message" : "send_private_message", { ...target, message }, active);
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

  async function reviewPendingGroupJoin(groupId: number, actor: number, user: number, approve: boolean,
    combined: AbortSignal): Promise<PendingGroupJoinDecision> {
    if (!joinReview || !positiveId(user) || user === account || typeof approve !== "boolean") return { status: "unavailable" };
    const active = () => !combined.aborted && options.canModerateGroups?.() !== false;
    const authorized = () => groupOperatorAuthority(id => memberRole(groupId, id, combined), account, actor, () => isMaster(actor), active);
    if (!await authorized()) return { status: "unavailable" };
    const list = await readPendingGroupJoins(groupId, combined);
    if (!active() || !list?.complete) return { status: "unavailable" };
    const matches = list.entries.filter(entry => entry.userId === user);
    if (!matches.length) return { status: "not-found" };
    if (matches.some(entry => entry.risk)) return { status: "risk" };
    const [selected] = matches;
    if (matches.length !== 1 || !selected) return { status: "ambiguous" };
    const pending = await verifyPendingGroupJoin(selected.origin, combined);
    if (pending !== "pending") return { status: pending };
    const status = await joinReview.once(selected.origin, async () => {
      if (!await authorized() || !active()) return "unavailable";
      return submitGroupJoin(selected.origin, approve, combined);
    });
    return { status, nickname: selected.nickname };
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
      return { role: member.role, name: memberDisplayName(member.card) || memberDisplayName(member.nickname),
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

  return { botId: account, checkinNotify, ownGroupCardAccount: bindCard(), async timedWholeMute(binding, jobSignal) {
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
    async function sendReply(target: { group_id: number } | { user_id: number }, reply: MessageReply,
      onDelivered?: ReplyOptions["onDelivered"]) {
      const content = encodeMilkyReply(reply);
      if (!content) return false;
      const action = "group_id" in target ? "send_group_message" : "send_private_message";
      const result = await call.confirmed(action, { ...target, message: content });
      if (result.status === "rejected") return false;
      if (result.status === "unknown" || !hasMessageSequence(result.data.message_seq)) {
        throw new Error("Milky 通知回复未确认。");
      }
      confirmSent(target, result.data, content);
      await notifyReplyDelivery(onDelivered, result.data.message_seq);
      return true;
    }

    if (body.event_type === "group_mute" && options.onMemberMute) {
      const { time } = body;
      const { group_id, user_id, operator_id, duration } = body.data;
      if (positiveId(group_id) && positiveId(user_id) && positiveId(operator_id) && positiveId(time) &&
          isMemberMuteDuration(duration)) {
        options.onMemberMute({ self_id: account, group_id, user_id, operator_id, time, duration, signal,
          canModerate: active => canModerateGroupSubject(id => memberRole(group_id, id, active), account, user_id),
          async unmute(active) {
            return (await call.confirmed("set_group_member_mute", { group_id, user_id, duration: 0 }, active)).status;
          },
          reply: reply => sendReply({ group_id }, reply),
        });
      }
      return "accepted";
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
          : confirmJoinReview(kind === "add" ? joinReview : undefined, { adapter: "milky", botId: account, flag },
            () => groupReviews.review(account, flag, kind, accept, reason, call.confirmed)),
        sendGroup: (group_id, reply, onDelivered) => sendReply({ group_id }, reply, onDelivered),
        sendPrivate: (user_id, reply) => sendReply({ user_id }, reply),
        masterIds: options.masterIds?.(account) ?? [],
      });
      if (candidate) {
        const { decision, joinRequestOrigin, ...request } = candidate;
        if (groupReviews.register(request, decision)) {
          groupRequest = request;
          if (kind === "add") bindGroupModeration(request, {
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
    const scopedMessage = message && {
      ...message, adapter: "milky" as const, groupRequestScope: "milky" as const, canReviewGroupRequests: canReview,
      [delegationSession]: delegation,
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
        role: id => delegation.memberRole(groupId, id),
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
      reviewGroupRequest: canReview ? (flag: string, kind: "add" | "invite", accept: boolean, reason?: string) =>
        !signal.aborted && positiveId(message.user_id) && isMaster(message.user_id)
          ? confirmJoinReview(kind === "add" ? joinReview : undefined, { adapter: "milky", botId: account, flag },
            () => groupReviews.review(account, flag, kind, accept, reason, call.confirmed))
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
