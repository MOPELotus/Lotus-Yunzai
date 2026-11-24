import { sanitizeRuntimeLog } from "../runtime-logs.ts";
import { createHash } from "node:crypto";
import { chatFileRelaySource, isChatFileName, maxChatFileBytes, qqChatFileUrl, readQqChatFile, type ChatFileRelaySource, type IncomingChatFile } from "../chat-files.ts";
import { sendSessionMedia } from "../media-delivery.ts";
import { delegationSession } from "../command-delegation.ts";
import { groupExportSession } from "../group-member-export.ts";
import { ownerContactListSession } from "../owner-contact-list.ts";
import { manualGroupLeaveSession } from "../manual-group-leave.ts";
import { createQuotedRecall, quotedRecallSessions } from "../quoted-recall.ts";
import { findQuotedGroupFile, quotedGroupFile } from "./quoted-group-file.ts";
import { bindQuotedOwnerFriendReply, friendMessageNoticeSession, type FriendMessageReceipts, type NativeFriendRelationshipNotice } from "../friend-message-notice.ts";
import { notifyOwnReply, notifyReplyDelivery, replyRecallSeconds, segment, type BotEvent, type FileUploadNotice, type FriendPoke, type FriendRequest, type GroupNotice, type GroupPoke,
  type GroupRequest, type MessageEvent, type MessageRecallNotice, type MessageReply, type OneBotGroupCompatibilityNotice, type OneBotLegacySignal,
  type OneBotPokeRecallNotice, type OneBotProfileLikeNotice, type QuotedMessage } from "../messages.ts";
import { authorized } from "../server.ts";
import { bindGroupCard } from "./group-card.ts";
import { bindGroupName } from "./group-name.ts";
import { bindGroupAvatar, groupAvatarSession } from "./group-avatar.ts";
import { bindOwnerAccount, ownerAccountSession } from "./owner-account.ts";
import { qzoneSession, type QzoneSession } from "./qzone.ts";
import { bindGroupModeration, bindGroupRuleImageDigest, bindGroupVerificationScope, bindMessageGroupActions, bindMixedGroupImageParts,
  bindPrivateGroupActions, bindSingleGroupImageDigest, canModerateGroupSubject, groupMayReadPendingJoins, groupOperatorAuthority,
  isMemberMuteDuration, type GroupActionPolicy, type NativeGroupOwnerGroupNotice } from "./group-moderation.ts";
import { confirmJoinReview } from "../group-join-review.ts";
import { bindMentionLike, mentionedProfileId } from "./mention-like.ts";
import { isRequestFlag, OneBotCalls, OneBotNotSentError, type OneBotAction, type Send } from "./onebot-calls.ts";
import type { OneBotGroups } from "./onebot-groups.ts";
import { legacyGroupMemberRoster, OneBotMemberDisplay } from "./onebot-member-display.ts";
import { decodeOneBotMessage, encodeOneBotForward, encodeOneBotMusicCard, encodeOneBotReply } from "./onebot-message.ts";
import { OneBotMutes } from "./onebot-mutes.ts";
import { bindOwnGroupCard, ownGroupCardSession, type OwnGroupCardAccount } from "./own-group-card.ts";
import { bindOwnerFriendReply } from "./owner-friend-reply.ts";
import type { createRequestClaim, RequestDecisionOutcome } from "../request-claim.ts";

const bindQuotedRecall = createQuotedRecall();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function oneBotMessageId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isInteger(id) && id !== 0 && id >= -2_147_483_648 && id <= 2_147_483_647) return id;
}

async function readOneBotQuote(
  calls: OneBotCalls, send: Send, id: number, selfId: number, target: { group_id: number } | { user_id: number },
  scopedRecall?: AbortSignal, includeAttachment = false,
): Promise<QuotedMessage | undefined> {
  const quote = await calls.getMessage(send, id, scopedRecall);
  if (!quote || oneBotMessageId(quote.message_id) !== id || ("self_id" in quote && quote.self_id !== selfId)) return;
  const sender = isRecord(quote.sender) ? quote.sender.user_id : undefined;
  if (!isId(sender) || (scopedRecall && "user_id" in quote && quote.user_id !== sender)) return;
  if ("group_id" in target) {
    if (quote.message_type !== "group" || quote.group_id !== target.group_id) return;
  } else {
    const paired = sender === selfId ? target.user_id : selfId;
    function matchingPrivateScope(value: Record<string, unknown>) {
      return value.message_type === "private" && !isId(value.group_id) &&
        (!("sub_type" in value) || value.sub_type === "friend") &&
        (!("target_id" in value) || value.target_id === paired);
    }
    if (!matchingPrivateScope(quote) || (sender !== target.user_id && sender !== selfId)) return;
    if (sender === selfId && !("target_id" in quote)) {
      // NapCat's get_msg omits the peer of outbound friend messages.
      // Its scoped friend history must independently return the same message from this bot.
      if (!scopedRecall) return;
      const history = await calls.readPrivateHistoryMessage(send, target.user_id, id, scopedRecall);
      if (!history || !matchingPrivateScope(history) || ("self_id" in history && history.self_id !== selfId) ||
          ("user_id" in history && history.user_id !== selfId) || !isRecord(history.sender) || history.sender.user_id !== selfId) return;
    }
  }
  const message = decodeOneBotMessage(quote.message, selfId)?.message;
  if (!message) return;
  const rawFile = includeAttachment && scopedRecall && message[0]?.type === "file" ? structuredAttachment(quote.message) : undefined;
  const attachment = rawFile && scopedRecall && incomingAttachment(scopedRecall, calls, send, target, rawFile, "message");
  return { user_id: sender, message, ...(attachment ? { attachment } : {}) };
}

interface ConnectionData {
  readonly calls: OneBotCalls;
  readonly mutes: OneBotMutes;
  readonly attachmentSession?: AbortController;
  botId?: number;
  detach?: () => void;
  display?: OneBotMemberDisplay;
  skipInitialRoster?: Set<number>;
  joinRoster?: Map<number, symbol>;
  ownGroupCardAccount?: (authorized?: () => boolean) => OwnGroupCardAccount;
  receivedOffline?: boolean;
}

interface OwnerNoticeOptions {
  readonly reserveFileNotice?: (event: MessageEvent) => symbol | undefined;
  readonly masterIds?: (bot: number) => readonly number[];
  readonly friendNoticeReceipts?: FriendMessageReceipts;
  readonly ownerFriendReplyClaim?: ReturnType<typeof createRequestClaim>;
  readonly friendRequestReviewClaim?: ReturnType<typeof createRequestClaim>;
  readonly invitationReviewClaim?: ReturnType<typeof createRequestClaim>;
  readonly onFriendRelationship?: (notice: NativeFriendRelationshipNotice) => void;
}

function decideOneBotRequest(claim: NonNullable<OwnerNoticeOptions["friendRequestReviewClaim"]>, botId: number, flag: string,
  active: () => boolean, write: () => Promise<boolean>): Promise<RequestDecisionOutcome> {
  return claim({ adapter: "onebot", botId, flag }, async () => {
    if (!active()) return "unavailable";
    try {
      return await write() ? "confirmed" : "rejected";
    } catch (error) {
      return error instanceof OneBotNotSentError ? "unavailable" : "unknown";
    }
  });
}

async function confirmedOneBotRequest(outcome: Promise<RequestDecisionOutcome>) {
  const status = await outcome;
  if (status === "unknown") throw new Error("OneBot 请求审核结果未确认。");
  return status === "confirmed";
}

function attachmentSize(value: unknown): number | undefined {
  const size = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= maxChatFileBytes) return size;
}

function attachmentId(value: unknown, name: string): string | undefined {
  if (typeof value === "string" && value !== name && value.length <= 1024 && /^\/?[A-Za-z0-9_+-]+={0,2}$/u.test(value)) {
    return value;
  }
}

function incomingAttachment(
  session: AbortSignal, calls: OneBotCalls, send: Send, target: { group_id: number } | { user_id: number },
  data: Record<string, unknown>, source: "message" | "group_upload" | "offline_file",
): IncomingChatFile | undefined {
  if (session.aborted) return;
  const name = source === "message" ? data.file : data.name;
  if (!isChatFileName(name)) return;
  const rawSize = source === "message" ? data.file_size : data.size;
  const size = attachmentSize(rawSize);
  if (rawSize !== undefined && size === undefined) return;
  const fileId = attachmentId(source === "group_upload" ? data.id : data.file_id, name);
  const busid = "group_id" in target && typeof data.busid === "number" && Number.isSafeInteger(data.busid) && data.busid >= 0
    ? data.busid : undefined;
  const directUrl = source === "offline_file" ? qqChatFileUrl(data.url)?.href : undefined;
  if (!fileId && directUrl === undefined) return;
  const fileTarget = busid !== undefined ? { ...target, busid } : target;
  return Object.freeze({
    name, size,
    async read(signal?: AbortSignal) {
      const readSignal = signal ? AbortSignal.any([session, signal]) : session;
      if (readSignal.aborted) return;
      return fileId ? calls.readFile(send, fileTarget, fileId, name, size, readSignal) : readQqChatFile(directUrl, size, readSignal);
    },
  });
}

function structuredAttachment(message: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(message)) return;
  const files = message.filter((part: unknown) => isRecord(part) && part.type === "file");
  const data = files.length === 1 ? files[0]?.data : undefined;
  return isRecord(data) ? data : undefined;
}

function sendFrame(socket: Bun.ServerWebSocket<ConnectionData>, output: string): boolean {
  return socket.readyState === WebSocket.OPEN && socket.send(output) !== 0;
}

function isLoopback(address?: string): boolean {
  return address === "::1" || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/u.test(address ?? "");
}

interface MessageIdentity {
  self_id?: number;
  user_id?: number;
  group_id?: number;
}

function sentMessage(frame: OneBotAction, source: MessageIdentity, record: (identity: MessageIdentity, message?: unknown) => void) {
  if (!isRecord(frame.params)) return;
  const { group_id, user_id, message, messages } = frame.params;
  const group = isId(group_id) ? group_id : undefined;
  const identity = {
    self_id: source.self_id,
    group_id: group,
    user_id: group !== undefined
      ? (group === source.group_id ? source.user_id : undefined)
      : (isId(user_id) ? user_id : undefined),
  };
  if (frame.action === "send_msg") record(identity, message);
  else if (frame.action === "send_group_forward_msg" || frame.action === "send_private_forward_msg") record(identity, messages);
}

async function notifyOwnerReplies(calls: OneBotCalls, send: Send, bot: number, owners: readonly number[], reply: MessageReply,
  signal: AbortSignal, onDelivered?: (owner: number, messageId: number) => Promise<void>, followup?: MessageReply,
  allowFollowup?: (owner: number) => boolean) {
  const message = encodeOneBotReply(reply);
  const next = followup === undefined ? undefined : encodeOneBotReply(followup);
  if (signal.aborted || message === undefined || (followup !== undefined && next === undefined)) return 0;
  const recipients = [...new Set(owners)].filter(id => isId(id) && id !== bot);
  const deliveries = await Promise.all(recipients.map(async user_id => {
    const target = { user_id };
    const status = await calls.sendConfirmed(send, target, message, signal, onDelivered ? id => onDelivered(user_id, id) : undefined);
    if (status === "confirmed" && next !== undefined && !signal.aborted && allowFollowup?.(user_id) !== false) {
      await calls.sendConfirmed(send, target, next, signal);
    }
    return status;
  }));
  return deliveries.filter(result => result === "confirmed").length;
}

async function selectNoticeOwners(options: (GroupActionPolicy & OwnerNoticeOptions) | undefined, bot: number, signal: AbortSignal,
  authorized: (bot: number, user: number) => boolean) {
  if (signal.aborted) return [];
  const users = await (options?.noticeOwnerIds?.(bot, signal) ?? options?.masterIds?.(bot) ?? []);
  return signal.aborted ? [] : users.filter(id => authorized(bot, id));
}

async function notifyVerifiedFriendOwners(calls: OneBotCalls, send: Send, bot: number, owners: (signal: AbortSignal) => Promise<readonly number[]>,
  reply: MessageReply, signal: AbortSignal,
  { source, followup, allowFollowup }: { source?: number; followup?: MessageReply; allowFollowup?: (owner: number) => boolean } = {}) {
  const recipients = await owners(signal);
  if (signal.aborted || !recipients.length) return 0;
  const profiles = await calls.listFriendProfiles(send, signal).catch(() => []);
  const peers = new Set(profiles.map(profile => String(profile.user_id)));
  if (source !== undefined && !peers.has(String(source))) return 0;
  return notifyOwnerReplies(calls, send, bot, recipients.filter(id => peers.has(String(id))), reply, signal, undefined, followup, allowFollowup);
}

async function dispatchRequest(
  dispatch: (event: FriendRequest | GroupRequest) => Promise<void>,
  send: Send,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  permissions: GroupActionPolicy & OwnerNoticeOptions & { isMaster(bot: number, user: number): boolean; masterIds(bot: number): readonly number[] },
  connection: ConnectionData,
): Promise<void> {
  const { request_type, sub_type, self_id, user_id, group_id, flag } = event;
  if (!isId(self_id) || !isId(user_id) || !isRequestFlag(flag)) return;

  function replyToApplicant(reply: MessageReply): boolean | Promise<boolean> {
    const message = encodeOneBotReply(reply);
    return message !== undefined &&
      calls.replyWithConfirmation(send, { message_type: "private", user_id, message, auto_escape: true });
  }

  const common = () => ({
    post_type: "request" as const, self_id, user_id, flag,
    comment: stringField(event.comment),
    isMaster: permissions.isMaster(self_id, user_id),
    async notifyMasters(message: string) {
      if (typeof message !== "string" || !message) return 0;
      const recipients = permissions.masterIds(self_id).filter((id) => id !== self_id);
      const delivered = await Promise.all(recipients.map((user_id) =>
        calls.replyWithConfirmation(send, { message_type: "private", user_id, message, auto_escape: true })));
      return delivered.filter(Boolean).length;
    },
  });

  if (request_type === "friend") {
    const session = groupActionSignal(connection, self_id);
    if (!session || self_id === user_id) return;
    const nickname = stringField(event.nickname);
    const source = stringField(event.source);
    calls.observeFriendRequest(flag, {
      userId: user_id, nickname, source, comment: stringField(event.comment), time: isId(event.time) ? event.time : undefined,
    });
    await dispatch({
      ...common(), request_type, sub_type: "add", isGroup: false, isPrivate: true,
      nickname, source, approvalSignal: session,
      async notifyOwners(reply, workflow) {
        const active = AbortSignal.any([session, workflow]);
        return notifyOwnerReplies(calls, send, self_id, await selectNoticeOwners(permissions, self_id, active, permissions.isMaster), reply, active);
      },
      approve(approve = true, remark) {
        const write = () => calls.reviewFriendRequest(send, flag, approve, remark, session);
        return permissions.friendRequestReviewClaim
          ? confirmedOneBotRequest(decideOneBotRequest(permissions.friendRequestReviewClaim, self_id, flag, () => !session.aborted, write))
          : write();
      },
      reply: replyToApplicant,
    });
    return;
  }

  if (request_type !== "group" || (sub_type !== "add" && sub_type !== "invite") || !isId(group_id)) return;
  const reviewKey = { adapter: "onebot" as const, botId: self_id, flag };
  const joinReview = sub_type === "add" ? permissions.joinReview : undefined;
  const session = groupActionSignal(connection, self_id);
  if (sub_type === "invite" && !session) return;
  if (sub_type === "invite" && user_id !== self_id) {
    calls.observeGroupInvitation(flag, { groupId: group_id, inviterId: user_id, groupName: stringField(event.group_name), nickname: stringField(event.nickname) });
  }

  const request: GroupRequest = {
    ...common(), request_type, sub_type, group_id, isGroup: true, isPrivate: false,
    group_name: stringField(event.group_name),
    nickname: stringField(event.nickname),
    inviter_id: isId(event.inviter_id) ? event.inviter_id : undefined,
    notifyOwners: session ? (reply, active) => notifyVerifiedFriendOwners(calls, send, self_id,
      scope => selectNoticeOwners(permissions, self_id, scope, permissions.isMaster), reply, AbortSignal.any([session, active])) : undefined,
    approve(approve = true, reason) {
      if (sub_type === "add") return confirmJoinReview(joinReview, reviewKey, () => calls.reviewGroupRequest(send, flag, sub_type, approve, reason));
      if (!session || session.aborted) return Promise.resolve(false);
      const write = () => calls.reviewGroupRequest(send, flag, sub_type, approve, reason, session);
      return permissions.invitationReviewClaim
        ? confirmedOneBotRequest(decideOneBotRequest(permissions.invitationReviewClaim, self_id, flag, () => !session.aborted, write))
        : write();
    },
    replyToApplicant,
    reply(reply, _quote, options) {
      const message = encodeOneBotReply(reply);
      if (message === undefined) return false;
      const params = { message_type: "group", group_id, message, auto_escape: true };
      return options?.onDelivered ? calls.replyWithReceipt(send, params, undefined, undefined, options.onDelivered)
        : calls.replyWithConfirmation(send, params);
    },
  };
  if (session && sub_type === "add") bindGroupModeration(request, {
    signal: session,
    joinRequestOrigin: { ...reviewKey, groupId: group_id, userId: user_id, nickname: request.nickname },
    canModerate: active => canModerateGroupSubject(id => calls.getGroupRole(send, group_id, id, true, active), self_id),
    async act(signal, reason = "主动退群被拉黑") {
      if (!joinReview) return calls.declineGroupApplication(send, flag, signal, reason);
      const status = await joinReview.once(reviewKey, () => calls.declineGroupApplication(send, flag, signal, reason));
      return status === "unavailable" ? "rejected" : status;
    },
  });
  else if (session) bindGroupModeration(request, { signal: session });
  await dispatch(request);
}

function groupActionSignal(connection: ConnectionData, botId: number) {
  const signal = connection.attachmentSession?.signal;
  if (connection.botId === botId && connection.display?.closed === false && signal?.aborted === false) return signal;
}

async function dispatchGroupNotice(
  dispatch: (event: GroupNotice) => Promise<void>,
  send: Send,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  options: GroupActionPolicy & { isMaster(bot: number, user: number): boolean; masterIds(bot: number): readonly number[] },
  connection: ConnectionData,
): Promise<void> {
  const { notice_type, user_id, group_id, self_id, operator_id, time } = event;
  if (notice_type !== "group_increase" && notice_type !== "group_decrease") return;
  if (!isId(group_id) || !isId(self_id)) return;

  const sub_type = notice_type === "group_increase" ? "increase" : "decrease";
  const action = stringField(event.sub_type);
  const session = groupActionSignal(connection, self_id);
  const notifyOwners = session && ((reply: MessageReply, active: AbortSignal) => notifyVerifiedFriendOwners(calls, send, self_id,
    scope => selectNoticeOwners(options, self_id, scope, options.isMaster), reply, AbortSignal.any([session, active])));
  if (session && notifyOwners && options.onGroupOwnerGroupNotice && isId(time)) {
    const operator = isId(operator_id) ? operator_id : undefined;
    const removed = action === "kick_me" || (action === "kick" && operator !== undefined && operator !== self_id);
    let kind: NativeGroupOwnerGroupNotice["kind"] | undefined;
    if (sub_type === "decrease" && action === "disband") kind = "dissolved";
    else if (user_id === self_id) {
      if (sub_type === "increase") kind = "joined";
      else if (action === "leave") kind = "left";
      else kind = removed ? "removed" : "departed";
    }
    if (kind) {
      options.onGroupOwnerGroupNotice({ adapter: "onebot", botId: self_id, groupId: group_id, time, kind, signal: session,
        operatorId: kind === "removed" && operator === self_id ? undefined : operator,
        describe: active => calls.getGroupName(send, group_id, active, true), notifyOwners,
      });
    }
  }
  if (!isId(user_id)) return;
  const source = isRecord(event.member) ? event.member : undefined;
  const display = self_id === connection.botId && connection.display?.closed === false ? connection.display : undefined;
  const cached = display?.peek(group_id, user_id);
  const nickname = stringField(event.nickname);
  const member = source || cached ? {
    card: stringField(source?.card) ?? cached?.card,
    nickname: stringField(source?.nickname) ?? (display ? nickname ?? cached?.nickname : undefined),
  } : undefined;
  const selfJoined = sub_type === "increase" && user_id === self_id && self_id === connection.botId;
  const joins = display ? connection.joinRoster : undefined;
  const join = selfJoined && joins ? Symbol() : undefined;
  if (display) {
    if (user_id === self_id) {
      connection.skipInitialRoster?.add(group_id);
      if (join) joins?.set(group_id, join);
      else {
        joins?.delete(group_id);
        display.forget(group_id);
      }
    } else if (sub_type === "decrease") {
      display.remove(group_id, user_id);
    } else {
      display.remember(group_id, user_id, { card: stringField(source?.card), nickname: stringField(source?.nickname) ?? nickname });
    }
  }
  let left = false;
  const notice: GroupNotice = {
    post_type: "notice",
    notice_type: "group",
    sub_type,
    time: isId(time) ? time : undefined,
    action_sub_type: action,
    increase_type: sub_type === "increase" ? action : undefined,
    decrease_type: sub_type === "decrease" ? action : undefined,
    inviter_id: sub_type === "increase" && action === "invite" && isId(operator_id) ? operator_id : undefined,
    user_id, group_id, self_id,
    operator_id: isId(operator_id) ? operator_id : undefined,
    group_name: stringField(event.group_name),
    getGroupName: () => calls.getGroupName(send, group_id),
    inspectAutoQuit: selfJoined && session && isId(time) ? (maxMembers, active) =>
      calls.inspectAutoQuit(send, group_id, self_id, time, maxMembers, active ? AbortSignal.any([session, active]) : session) : undefined,
    leaveGroup: selfJoined && session && isId(time) ? async () => {
      if (session.aborted) return false;
      const accepted = await calls.leaveGroup(send, group_id);
      left ||= accepted;
      if (accepted && join && joins?.get(group_id) === join) display?.forget(group_id);
      return accepted;
    } : undefined,
    nickname: nickname ?? (display ? member?.nickname : undefined),
    member,
    dismiss: typeof event.dismiss === "boolean" ? event.dismiss : undefined,
    isGroup: true,
    isPrivate: false,
    isMaster: isId(operator_id) && options.isMaster(self_id, operator_id),
    reply(reply) {
      const message = encodeOneBotReply(reply);
      if (message === undefined) return false;
      return calls.replyWithConfirmation(send, { message_type: "group", group_id, message, auto_escape: true });
    },
  };
  if (session && notifyOwners && user_id !== self_id && notice.dismiss !== true && action !== "disband") {
    options.onGroupOwnerMemberNotice?.({ adapter: "onebot", event: notice, signal: session,
      async describe(active) {
        const [groupName, subject] = await Promise.all([
          calls.getGroupName(send, group_id, active, true),
          sub_type === "increase" && !member?.nickname ? calls.getLiveGroupMember(send, group_id, user_id, true, active) : undefined,
        ]);
        return { groupName, nickname: subject?.nickname ?? member?.nickname, card: subject?.card ?? member?.card };
      },
      notifyOwners,
    });
  }
  if (session) bindGroupModeration(notice, {
    signal: session,
    groupVerification: {
      adapter: "onebot",
      member: (user, active) => calls.getLiveGroupMember(send, group_id, user, true, active),
      async send(reply, active) {
        const message = encodeOneBotReply(reply);
        return message !== undefined && await calls.sendConfirmed(send, { group_id }, message, active) === "confirmed";
      },
    },
    canModerate: active => canModerateGroupSubject(id => calls.getGroupRole(send, group_id, id, true, active), self_id, user_id),
    act: sub_type === "increase" && self_id !== user_id
      ? signal => calls.kickGroupMember(send, group_id, user_id, signal) : undefined,
  });
  try {
    await dispatch(notice);
    if (join && joins?.get(group_id) === join && !left) void display?.warm(group_id);
  } finally {
    if (join && joins?.get(group_id) === join) joins?.delete(group_id);
  }
}

async function dispatchFriendPoke(
  dispatch: (event: FriendPoke) => Promise<void>,
  send: Send,
  event: Record<string, unknown>,
  connection: ConnectionData,
  permissions: GroupActionPolicy & { isMaster: (bot: number, user: number) => boolean; masterIds: (bot: number) => readonly number[] },
): Promise<void> {
  const { self_id, target_id, time } = event;
  const user_id = event.user_id ?? event.operator_id;
  if (!isId(self_id) || target_id !== self_id || !isId(user_id) || user_id === self_id) return;
  const signal = groupActionSignal(connection, self_id);
  await dispatch({
    post_type: "notice", notice_type: "friend", sub_type: "poke",
    self_id, user_id, operator_id: user_id, target_id,
    time: isId(time) ? time : undefined,
    [friendMessageNoticeSession]: signal ? {
      signal,
      notifyOwners: (reply, workflow) => notifyVerifiedFriendOwners(connection.calls, send, self_id,
        scope => selectNoticeOwners(permissions, self_id, scope, permissions.isMaster), reply,
        AbortSignal.any([signal, workflow]), { source: user_id }),
    } : undefined,
    isGroup: false, isPrivate: true, isMaster: permissions.isMaster(self_id, user_id),
    reply(reply) {
      const message = encodeOneBotReply(reply);
      return message !== undefined && send({
        action: "send_msg", params: { message_type: "private", user_id, message, auto_escape: true },
      });
    },
  });
}

async function dispatchGroupPoke(
  dispatch: (event: GroupPoke) => Promise<void>, send: Send, event: Record<string, unknown>,
  connection: ConnectionData, isMaster: (bot: number, user: number) => boolean,
) {
  const { self_id, group_id, target_id, time } = event;
  const user_id = event.user_id ?? event.operator_id;
  if (!isId(self_id) || !isId(group_id) || !isId(user_id) || !isId(target_id)) return;
  const signal = groupActionSignal(connection, self_id);
  if (!signal) return;
  await dispatch({
    post_type: "notice", notice_type: "group", sub_type: "poke",
    self_id, group_id, user_id, operator_id: user_id, target_id,
    time: isId(time) ? time : undefined,
    isGroup: true, isPrivate: false, isMaster: isMaster(self_id, user_id),
    reply(reply) {
      if (signal.aborted) return false;
      const message = encodeOneBotReply(reply);
      return message !== undefined && send({
        action: "send_msg", params: { message_type: "group", group_id, message, auto_escape: true },
      });
    },
  });
}

async function dispatchGroupCompatibilityNotice(
  dispatch: (event: OneBotGroupCompatibilityNotice) => Promise<void>, send: Send, event: Record<string, unknown>,
  connection: ConnectionData, isMaster: (bot: number, user: number) => boolean,
) {
  const { self_id, group_id, time, notice_type, sub_type, target_id } = event;
  if (!isId(self_id) || !isId(group_id)) return;
  const signal = groupActionSignal(connection, self_id);
  if (!signal) return;
  const operator_id = event.operator_id === 0 || isId(event.operator_id) ? event.operator_id : undefined;
  const user_id = event.user_id ?? (notice_type === "notify" ? operator_id || target_id : undefined);
  const base = {
    post_type: "notice" as const, adapter: "onebot" as const, self_id, group_id, operator_id,
    time: isId(time) ? time : undefined, user_id: isId(user_id) ? user_id : undefined,
    isGroup: true as const, isPrivate: false as const, isMaster: isId(user_id) && isMaster(self_id, user_id),
    reply(reply: MessageReply) {
      if (signal.aborted) return false;
      const message = encodeOneBotReply(reply);
      return message !== undefined && send({
        action: "send_msg", params: { message_type: "group", group_id, message, auto_escape: true },
      });
    },
  };
  const refreshMember = (memberId: number) => {
    void connection.calls.getLiveGroupMember(send, group_id, memberId, true, signal).then(member => {
      if (member && !signal.aborted) connection.display?.remember(group_id, memberId, member);
    });
  };
  if (notice_type === "group_admin") {
    if (!isId(user_id) || (sub_type !== "set" && sub_type !== "unset")) return;
    refreshMember(user_id);
    await dispatch({ ...base, notice_type: "group", sub_type: "admin", user_id,
      action_sub_type: sub_type, set: sub_type === "set" });
  } else if (notice_type === "group_ban") {
    const { duration } = event;
    if ((user_id !== 0 && !isId(user_id)) || !isId(operator_id) ||
        (sub_type !== "ban" && sub_type !== "lift_ban")) return;
    if (duration === -1) {
      if (user_id !== 0 || sub_type !== "ban") return;
    } else if (!isMemberMuteDuration(duration) || (sub_type === "ban") !== (duration > 0)) return;
    if (user_id !== 0) refreshMember(user_id);
    await dispatch({ ...base, notice_type: "group", sub_type: "ban", user_id, operator_id, duration, action_sub_type: sub_type });
  } else if (notice_type === "group_card") {
    const { card_old, card_new } = event;
    if (!isId(user_id) || typeof card_new !== "string") return;
    connection.display?.remember(group_id, user_id, { card: card_new });
    await dispatch({ ...base, notice_type, card_old: stringField(card_old), card_new });
  } else if (notice_type === "notify" && sub_type === "title") {
    if (!isId(user_id) || typeof event.title !== "string" || event.title.length > 256) return;
    refreshMember(user_id);
    console.info(`[${self_id}] 群 ${group_id} 成员 ${user_id} 的头衔：${sanitizeRuntimeLog(event.title, 256)}`);
    await dispatch({ ...base, notice_type: "group", sub_type, user_id, title: event.title });
  } else if (notice_type === "notify" && sub_type === "honor") {
    const { honor_type } = event;
    if (!isId(user_id) || typeof honor_type !== "string" || !/^[a-z][a-z0-9_]{0,31}$/u.test(honor_type)) return;
    refreshMember(user_id);
    await dispatch({ ...base, notice_type: "group", sub_type, user_id, honor_type });
  } else if (notice_type === "notify" && sub_type === "group_name" && typeof event.name_new === "string") {
    await dispatch({ ...base, notice_type: "group", sub_type, name_new: event.name_new,
      target_id: isId(target_id) ? target_id : undefined });
  } else if (notice_type === "essence" && (sub_type === "add" || sub_type === "delete")) {
    const message_id = oneBotMessageId(event.message_id);
    if (message_id === undefined || operator_id === undefined || !isId(event.sender_id)) return;
    await dispatch({ ...base, notice_type: "group_essence", sub_type, message_id, sender_id: event.sender_id });
  } else if (notice_type === "group_msg_emoji_like") {
    const message_id = oneBotMessageId(event.message_id);
    if (message_id === undefined || (user_id != null && user_id !== 0 && !isId(user_id)) || !Array.isArray(event.likes)) return;
    const likes: { emoji_id: string; count: number }[] = [];
    for (const like of event.likes) {
      if (!isRecord(like) || typeof like.emoji_id !== "string" || typeof like.count !== "number" ||
          !Number.isSafeInteger(like.count) || like.count < 0) return;
      likes.push({ emoji_id: like.emoji_id, count: like.count });
    }
    const { message_seq, is_add } = event;
    await dispatch({ ...base, notice_type, user_id: user_id === 0 ? 0 : base.user_id, message_id, likes,
      message_seq: message_seq === 0 || isId(message_seq) ||
        (typeof message_seq === "string" && /^\d{1,20}$/u.test(message_seq)) ? message_seq : undefined,
      is_add: typeof is_add === "boolean" ? is_add : undefined });
  }
}

async function dispatchPokeRecall(
  dispatch: (event: OneBotPokeRecallNotice) => Promise<void>, send: Send, event: Record<string, unknown>,
  connection: ConnectionData, isMaster: (bot: number, user: number) => boolean,
) {
  const { self_id, target_id, time, group_id } = event;
  const user_id = event.user_id ?? (event.operator_id || target_id);
  if (!isId(self_id) || !isId(user_id) || !isId(target_id)) return;
  const signal = groupActionSignal(connection, self_id);
  if (!signal) return;
  const group = isId(group_id);
  if (!group && ((group_id !== undefined && group_id !== 0) ||
      user_id === target_id || (self_id !== user_id && self_id !== target_id))) return;
  const peer = user_id === self_id ? target_id : user_id;
  const base = {
    post_type: "notice" as const, sub_type: "poke_recall" as const, adapter: "onebot" as const,
    self_id, user_id, operator_id: user_id, target_id, time: isId(time) ? time : undefined,
    isMaster: isMaster(self_id, user_id),
    reply(reply: MessageReply) {
      if (signal.aborted) return false;
      const message = encodeOneBotReply(reply);
      const target = group ? { message_type: "group", group_id } : { message_type: "private", user_id: peer };
      return message !== undefined && send({
        action: "send_msg", params: { ...target, message, auto_escape: true },
      });
    },
  };
  await dispatch(group
    ? { ...base, notice_type: "group", group_id, isGroup: true, isPrivate: false }
    : { ...base, notice_type: "friend", peer_id: peer, isGroup: false, isPrivate: true });
}

async function dispatchMessageRecallNotice(
  dispatch: (event: MessageRecallNotice) => Promise<void>, send: Send, event: Record<string, unknown>,
  connection: ConnectionData, isMaster: (bot: number, user: number) => boolean,
) {
  const { self_id, user_id, group_id, operator_id, time } = event;
  const message_id = oneBotMessageId(event.message_id);
  if (!isId(self_id) || !isId(user_id) || message_id === undefined) return;
  const signal = groupActionSignal(connection, self_id);
  if (!signal) return;
  const group = event.notice_type === "group_recall";
  if (group ? !isId(group_id) || !(isId(operator_id) || operator_id === 0)
    : ((group_id !== undefined && group_id !== 0) || (operator_id !== undefined && operator_id !== user_id))) return;
  const base = {
    post_type: "notice" as const, sub_type: "recall" as const, adapter: "onebot" as const,
    self_id, user_id, operator_id: typeof operator_id === "number" ? operator_id : undefined, message_id,
    time: isId(time) ? time : undefined, isMaster: isMaster(self_id, user_id),
    reply(reply: MessageReply) {
      if (signal.aborted || (!group && self_id === user_id)) return false;
      const message = encodeOneBotReply(reply);
      const target = group ? { message_type: "group", group_id } : { message_type: "private", user_id };
      return message !== undefined && send({ action: "send_msg", params: { ...target, message, auto_escape: true } });
    },
  };
  await dispatch(group && isId(group_id)
    ? { ...base, notice_type: "group", group_id, isGroup: true, isPrivate: false }
    : { ...base, notice_type: "friend", isGroup: false, isPrivate: true });
}

async function dispatchFileUploadNotice(
  dispatch: (event: FileUploadNotice) => Promise<void>, send: Send, event: Record<string, unknown>,
  connection: ConnectionData, isMaster: (bot: number, user: number) => boolean,
) {
  const { self_id, user_id, group_id, time, file } = event;
  const group = event.notice_type === "group_upload";
  if (!isId(self_id) || !isId(user_id) || (!group && self_id === user_id) || !isRecord(file) || !isChatFileName(file.name)) return;
  const signal = groupActionSignal(connection, self_id);
  if (!signal) return;
  if (group ? !isId(group_id) : group_id !== undefined && group_id !== 0) return;
  const id = attachmentId(group ? file.id : file.file_id, file.name);
  const url = group ? undefined : qqChatFileUrl(file.url)?.href;
  const size = typeof file.size === "string" && /^\d{1,16}$/u.test(file.size) ? Number(file.size) : file.size;
  if ((!id && !url) || (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0))) return;
  const busid = isId(file.busid) || file.busid === 0 ? file.busid : undefined;
  const base = {
    post_type: "notice" as const, adapter: "onebot" as const, self_id, user_id,
    time: isId(time) ? time : undefined, isMaster: isMaster(self_id, user_id),
    reply(reply: MessageReply) {
      if (signal.aborted) return false;
      const message = encodeOneBotReply(reply);
      const target = group ? { message_type: "group", group_id } : { message_type: "private", user_id };
      return message !== undefined && send({ action: "send_msg", params: { ...target, message, auto_escape: true } });
    },
  };
  const metadata = { name: file.name, size: typeof size === "number" ? size : undefined };
  await dispatch(group && isId(group_id)
    ? { ...base, notice_type: "group", sub_type: "upload", group_id, isGroup: true, isPrivate: false,
      file: { ...metadata, id, busid } }
    : { ...base, notice_type: "offline", sub_type: "file", isGroup: false, isPrivate: true,
      file: { ...metadata, file_id: id, url } });
}

async function dispatchProfileLike(
  dispatch: (event: OneBotProfileLikeNotice) => Promise<void>, send: Send, event: Record<string, unknown>,
  connection: ConnectionData, isMaster: (bot: number, user: number) => boolean,
) {
  const { self_id, operator_id, operator_nick, times, time, group_id } = event;
  if (!isId(self_id) || !isId(operator_id) || !isId(time) ||
      (group_id !== undefined && group_id !== 0) || typeof times !== "number" || !Number.isSafeInteger(times) || times < 0 ||
      typeof operator_nick !== "string" || operator_nick.length > 256) return;
  const signal = groupActionSignal(connection, self_id);
  if (!signal) return;
  console.info(`[${self_id}] 收到 ${operator_id} 的资料卡点赞 ${times} 次。`);
  await dispatch({
    post_type: "notice", notice_type: "friend", sub_type: "profile_like", adapter: "onebot",
    self_id, user_id: operator_id, operator_id, operator_nick, times, time,
    isGroup: false, isPrivate: true, isMaster: isMaster(self_id, operator_id),
    reply(reply) {
      const message = encodeOneBotReply(reply);
      return !signal.aborted && message !== undefined && send({
        action: "send_msg", params: { message_type: "private", user_id: operator_id, message, auto_escape: true },
      });
    },
  });
}

async function dispatchMessage(
  dispatch: (event: MessageEvent) => Promise<void>,
  send: Send,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  isMaster: (bot: number, user: number) => boolean,
  connection?: ConnectionData,
  noticeAttachment?: IncomingChatFile,
  groupActions?: GroupActionPolicy & OwnerNoticeOptions,
  fileNotice?: { readonly source: ChatFileRelaySource; readonly reserve?: OwnerNoticeOptions["reserveFileNotice"] },
): Promise<void> {
  const { mutes, botId: connectedBotId, display, attachmentSession } = connection ?? {};
  const userId = event.user_id;
  if (event.post_type !== "message" || !isId(userId) || userId === event.self_id) return;

  let target: { user_id: number } | { group_id: number };
  if (event.message_type === "private") {
    target = { user_id: userId };
  } else if (event.message_type === "group" && isId(event.group_id)) {
    target = { group_id: event.group_id };
  } else {
    return;
  }

  const selfId = isId(event.self_id) ? event.self_id : undefined;
  const incoming = decodeOneBotMessage(event.message, selfId);
  if (incoming === undefined) return;
  const boundAccount = selfId !== undefined && selfId === connectedBotId;
  const rawFile = !noticeAttachment && boundAccount && attachmentSession ? structuredAttachment(event.message) : undefined;
  const attachment = noticeAttachment ?? (rawFile && attachmentSession
    ? incomingAttachment(attachmentSession.signal, calls, send, target, rawFile, "message") : undefined);
  const { text, ...messageFields } = incoming;
  const sender = isRecord(event.sender) ? event.sender : undefined;
  const sourceId = oneBotMessageId(event.message_id);
  if (groupActions?.onGroupMessageSource && connection && selfId !== undefined && "group_id" in target &&
      !noticeAttachment && event.sub_type !== "anonymous" && sourceId !== undefined) {
    const signal = groupActionSignal(connection, selfId);
    const groupId = target.group_id;
    if (signal) groupActions.onGroupMessageSource({ adapter: "onebot", botId: selfId, groupId, userId, messageId: sourceId,
      message: incoming.message, nickname: stringField(sender?.nickname), signal,
      describeGroup: active => calls.getGroupName(send, groupId, active, true),
      notifyOwners: (reply, active, followup) => notifyVerifiedFriendOwners(calls, send, selfId,
        scope => selectNoticeOwners(groupActions, selfId, scope, isMaster), reply, AbortSignal.any([signal, active]),
        { followup, allowFollowup: id => isMaster(selfId, id) }),
    });
  }
  if (selfId !== undefined && selfId === connectedBotId && "group_id" in target && sender) {
    display?.remember(target.group_id, userId, { card: stringField(sender.card), nickname: stringField(sender.nickname) });
  }

  const messageType = event.message_type;
  const botMute = mutes && selfId !== undefined && "group_id" in target
    ? await mutes.forMessage(target.group_id, selfId, () => calls.getGroupRole(send, target.group_id, selfId))
    : undefined;
  const owner = selfId !== undefined && isMaster(selfId, userId);
  const likeSession = connection && selfId !== undefined && "group_id" in target && !noticeAttachment
    ? groupActionSignal(connection, selfId) : undefined;
  const mentioned = likeSession && selfId !== undefined ? mentionedProfileId(incoming.message, selfId, userId) : undefined;
  const messageId = typeof event.message_id === "number" && Number.isSafeInteger(event.message_id)
    ? event.message_id : undefined;
  const temporaryMessageId = oneBotMessageId(messageId);
  if (groupActions?.onTemporaryMessage && boundAccount && selfId !== undefined && attachmentSession && !noticeAttachment &&
      messageType === "private" && event.sub_type === "group" && temporaryMessageId !== undefined) {
    const signal = attachmentSession.signal;
    const reportedGroupId = isId(event.group_id) && event.group_id !== 284840486 ? event.group_id : undefined;
    groupActions.onTemporaryMessage({ adapter: "onebot", botId: selfId, userId, messageId: temporaryMessageId,
      message: incoming.message, reportedGroupId, signal,
      notifyOwners: (reply, workflow, followup) => notifyVerifiedFriendOwners(calls, send, selfId,
        scope => selectNoticeOwners(groupActions, selfId, scope, isMaster), reply, AbortSignal.any([signal, workflow]),
        { followup, allowFollowup: id => isMaster(selfId, id) }),
    });
  }
  const readRoster = async (groupId: number, active?: AbortSignal) => {
    const closed = () => display?.closed || attachmentSession?.signal.aborted || active?.aborted;
    if (closed()) return;
    const members = await calls.listMemberDisplay(send, groupId, true, active).catch(() => undefined);
    if (!closed()) return members;
  };
  const listCurrentRoster = boundAccount && display && "group_id" in target ? () => readRoster(target.group_id) : undefined;
  const listCheckinGroupMembers = listCurrentRoster && (async () =>
    (await listCurrentRoster())?.map(({ id, card, nickname }) => ({ id, name: card || nickname })));
  const quotedId = oneBotMessageId(incoming.reply_id);
  let quoted: Promise<QuotedMessage | undefined> | undefined;
  const lookupReply = quotedId !== undefined && selfId !== undefined && selfId === connectedBotId &&
    (messageType === "group" || event.sub_type === "friend")
    ? () => quoted ??= readOneBotQuote(calls, send, quotedId, selfId, target) : undefined;
  const joinReview = groupActions?.joinReview;
  const workflowSignal = likeSession ? groupActions?.groupWorkflowSignal?.() : undefined;
  const privateGroupSignal = owner && boundAccount && messageType === "private" && event.sub_type === "friend" && selfId !== undefined
    ? groupActions?.groupWorkflowSignal?.() : undefined;
  const ownerSignal = privateGroupSignal && attachmentSession && !noticeAttachment
    ? AbortSignal.any([privateGroupSignal, attachmentSession.signal]) : undefined;
  const ownerRequestActive = ownerSignal && selfId !== undefined &&
      (!sender || sender.user_id === undefined || sender.user_id === userId || sender.user_id === String(userId))
    ? () => !ownerSignal.aborted && isMaster(selfId, userId) : undefined;
  const friendRequestReviewClaim = groupActions?.friendRequestReviewClaim;
  const invitationReviewClaim = groupActions?.invitationReviewClaim;
  const leaveSignal = !noticeAttachment && temporaryMessageId !== undefined &&
      (!sender || sender.user_id === undefined || sender.user_id === userId) &&
      (messageType === "group" ? event.sub_type === "normal" : event.sub_type === "friend" && !isId(event.group_id)) &&
      connection && selfId !== undefined && groupActionSignal(connection, selfId);
  const groupSettings = leaveSignal && selfId !== undefined && ("group_id" in target || ownerSignal) ? {
    bot: selfId, actor: userId, group: "group_id" in target ? target.group_id : undefined,
    signal: ownerSignal ?? leaveSignal, isMaster: () => isMaster(selfId, userId),
    groupAllowed: (id: number) => "group_id" in target ? groupActions?.canModerateGroups?.() !== false
      : groupActions?.canModeratePrivateGroup?.(selfId, id) === true,
    role: (id: number, member: number, signal: AbortSignal) => calls.getGroupRole(send, id, member, true, signal),
  } : undefined;
  const ownerFriendReplyClaim = groupActions?.ownerFriendReplyClaim;
  const ownerFriendReply = ownerSignal && selfId !== undefined ? bindOwnerFriendReply({
    account: selfId, signal: ownerSignal, isOwner: () => isMaster(selfId, userId), source: incoming.message,
    claimDelivery: ownerFriendReplyClaim && messageId !== undefined ? sendReply => ownerFriendReplyClaim({
      adapter: "onebot", botId: selfId, flag: `${userId}:${messageId}`,
    }, sendReply) : undefined,
    isFriend: (target, active) => calls.isFriend(send, target, active),
    async send(target, reply, active) {
      const encoded = encodeOneBotReply(typeof reply === "string" ? [reply] : reply);
      return encoded === undefined ? "rejected" : calls.sendConfirmed(send, { user_id: target }, encoded, active);
    },
  }) : undefined;
  const friendNoticeReceipts = groupActions?.friendNoticeReceipts;
  const reference = rawFile && attachment && typeof rawFile.file === "string" ? attachmentId(rawFile.file_id, rawFile.file) : undefined;
  const inbound: MessageEvent = {
    msg: text.trim(),
    raw_message: typeof event.raw_message === "string" ? event.raw_message : stringField(event.message) ?? text,
    ...messageFields,
    file: incoming.message.find(({ type }) => type === "file"),
    attachment,
    canReadAttachments: boundAccount && !!attachmentSession && !attachmentSession.signal.aborted,
    [chatFileRelaySource]: fileNotice?.source ?? (reference && attachmentSession ? { reference, signal: attachmentSession.signal } : undefined),
    attachmentOnly: noticeAttachment !== undefined && messageType === "group" ? true : undefined,
    post_type: "message",
    message_type: messageType,
    sub_type: typeof event.sub_type === "string" ? event.sub_type : undefined,
    message_id: messageId,
    self_id: selfId,
    user_id: userId,
    group_id: "group_id" in target ? target.group_id : undefined,
    sender,
    member: messageType === "group" ? {
      is_admin: sender?.role === "admin",
      is_owner: sender?.role === "owner",
    } : undefined,
    botMute,
    isGroup: messageType === "group",
    isPrivate: messageType === "private",
    isMaster: owner,
    boundAccount,
    isNapCat: boundAccount && attachmentSession
      ? signal => calls.isNapCat(send, AbortSignal.any([signal, attachmentSession.signal])) : undefined,
    [manualGroupLeaveSession]: leaveSignal && selfId !== undefined ? {
      botId: selfId, userId, groupId: "group_id" in target ? target.group_id : undefined,
      signal: leaveSignal,
      isMaster: () => isMaster(selfId, userId),
      groups: active => calls.listGroups(send, active),
      async leave(groupId, active) {
        const result = await calls.leaveGroupConfirmed(send, groupId, active);
        if (result === "confirmed") display?.forget(groupId);
        return result;
      },
      reply: (text, active) => calls.sendConfirmed(send, target, text, active),
    } : undefined,
    [ownerContactListSession]: ownerSignal && selfId !== undefined && temporaryMessageId !== undefined && !isId(event.group_id) &&
        (!sender || sender.user_id === undefined || sender.user_id === userId) ? {
      botId: selfId, ownerId: userId, signal: ownerSignal,
      authorized: () => isMaster(selfId, userId),
      groups: active => calls.listGroups(send, active),
      friends: active => calls.readFriendProfiles(send, active),
      async forward(nodes, active) {
        const messages = encodeOneBotForward(nodes, selfId);
        return messages ? calls.sendForwardConfirmed(send, { user_id: userId }, messages, active) : "rejected";
      },
      reply: (text, active) => calls.sendConfirmed(send, { user_id: userId }, text, active),
    } : undefined,
    [friendMessageNoticeSession]: boundAccount && selfId !== undefined && attachmentSession && !noticeAttachment &&
      messageType === "private" && event.sub_type === "friend" ? {
        signal: attachmentSession.signal,
        async notifyOwners(reply, workflow, onDelivered, delivery) {
          const active = AbortSignal.any([attachmentSession.signal, workflow]);
          let owners = await selectNoticeOwners(groupActions, selfId, active, isMaster);
          if (delivery?.verifyRecipients && owners.length && !active.aborted) {
            const friends = new Set((await calls.listFriendProfiles(send, active).catch(() => [])).map(profile => String(profile.user_id)));
            owners = owners.filter(id => friends.has(String(id)) && isMaster(selfId, id));
          }
          return notifyOwnerReplies(calls, send, selfId, owners, reply, active, onDelivered, delivery?.followup,
            owner => isMaster(selfId, owner));
        },
      } : undefined,
    privateCredentialSignal: boundAccount && messageType === "private" && event.sub_type === "friend"
      ? attachmentSession?.signal : undefined,
    verifyOwnGroupMembership: boundAccount && leaveSignal && messageType === "private" && selfId !== undefined && selfId !== userId
      ? async (groupId, workflow) => {
        const active = AbortSignal.any([leaveSignal, workflow]);
        if (!isId(groupId) || active.aborted) return false;
        const [robot, actor] = await Promise.all([
          calls.getLiveGroupMember(send, groupId, selfId, true, active),
          calls.getLiveGroupMember(send, groupId, userId, true, active),
        ]);
        return !active.aborted && robot !== undefined && actor !== undefined;
      } : undefined,
    ...(privateGroupSignal && attachmentSession && selfId !== undefined && groupActions?.canModeratePrivateGroup &&
      bindPrivateGroupActions({ bot: selfId, signal: AbortSignal.any([privateGroupSignal, attachmentSession.signal]),
        master: () => isMaster(selfId, userId), protectedMember: id => groupActions.isProtectedMaster?.(selfId, id) ?? isMaster(selfId, id),
        allowed: groupId => groupActions.canModeratePrivateGroup?.(selfId, groupId) === true,
        member: (groupId, id, active) => calls.getLiveGroupMember(send, groupId, id, true, active),
        mute: (groupId, id, seconds, active) => calls.setGroupMute(send, groupId, id, seconds, active),
        kick: (groupId, id, active) => calls.kickGroupMember(send, groupId, id, active, false),
        wholeMute: (groupId, enabled, active) => calls.setGroupWholeMute(send, groupId, enabled, active),
        groupName: (groupId, active) => calls.getGroupName(send, groupId, active, true),
      })),
    setGroupName: groupSettings ? bindGroupName({
      ...groupSettings, write: (groupId, name, signal) => calls.setGroupName(send, groupId, name, signal),
    }) : undefined,
    [groupAvatarSession]: groupSettings ? bindGroupAvatar({
      ...groupSettings, available: signal => calls.isNapCat(send, signal),
      write: (groupId, file, signal) => calls.setGroupPortrait(send, groupId, file, signal),
    }) : undefined,
    [ownerAccountSession]: boundAccount && leaveSignal && selfId !== undefined ? bindOwnerAccount({
      signal: leaveSignal, actor: userId, privateChat: messageType === "private", isOwner: () => isMaster(selfId, userId),
      supported: (_operation, active) => calls.isNapCat(send, active), friends: active => calls.readCurrentFriendIds(send, active),
      write: (operation, active, current) => calls.updateOwnerAccount(send, selfId, operation, active, current),
    }) : undefined,
    [qzoneSession]: boundAccount && leaveSignal && messageType === "private" && selfId !== undefined ? {
      signal: leaveSignal, isOwner: () => isMaster(selfId, userId), supported: active => calls.isNapCat(send, active),
      isFriend: async active => await calls.friendship(send, userId, active) === true,
      list: (offset, count, active) => calls.listQzonePosts(send, selfId, offset, count, active),
      publish: (content, images, active) => calls.publishQzonePost(send, content, images, active),
      remove: (tid, active) => calls.deleteQzonePost(send, tid, active),
    } satisfies QzoneSession : undefined,
    likeSelf: (count) => calls.likeSelf(send, userId, count),
    profileLikeImageSignal: !noticeAttachment && connection && selfId !== undefined &&
      (messageType === "group" || event.sub_type === "friend") ? groupActionSignal(connection, selfId) : undefined,
    mentionLike: likeSession && mentioned !== undefined && "group_id" in target
      ? bindMentionLike(mentioned, likeSession,
        async () => await calls.getGroupRole(send, target.group_id, mentioned, true) !== undefined,
        () => calls.isFriend(send, mentioned),
        count => calls.likeSelf(send, mentioned, count, likeSession),
        () => calls.friendship(send, mentioned, likeSession))
      : undefined,
    ...(likeSession && selfId !== undefined && "group_id" in target && event.sub_type !== "anonymous" && bindMessageGroupActions({
      bot: selfId, actor: userId, signal: likeSession,
      accepting: groupActions?.canModerateGroups,
      isMaster: () => isMaster(selfId, userId),
      isProtected: id => (groupActions?.isProtectedMaster ?? isMaster)(selfId, id),
      async role(id, onName) {
        const member = await calls.getLiveGroupMember(send, target.group_id, id, true, likeSession);
        if (member?.name) onName?.(member.name);
        return member?.role;
      },
      readMemberActivity: id => calls.getLiveGroupMember(send, target.group_id, id, true, likeSession),
      mute: (id, seconds, active = likeSession) => calls.setGroupMute(send, target.group_id, id, seconds, active),
      wholeMute: enabled => calls.setGroupWholeMute(send, target.group_id, enabled, likeSession),
      kick: (id, block, active = likeSession) => calls.kickGroupMember(send, target.group_id, id, active, block),
      title: (id, text) => calls.setGroupSpecialTitle(send, target.group_id, id, text, likeSession),
      setAdmin: (id, enabled) => calls.setGroupAdmin(send, target.group_id, id, enabled, likeSession),
      essence: lookupReply && quotedId !== undefined ? {
        async verifyQuote() { return await lookupReply() !== undefined; },
        write: enabled => calls.setQuotedEssence(send, quotedId, enabled, likeSession),
      } : undefined,
      notice: {
        source: incoming.message,
        async send(reply) {
          const message = encodeOneBotReply(reply);
          return message === undefined ? "rejected" : calls.sendConfirmed(send, { group_id: target.group_id }, message);
        },
      },
      announcement: {
        source: incoming.message,
        available: () => calls.isNapCat(send, likeSession),
        list: () => calls.listGroupAnnouncements(send, target.group_id, likeSession),
        send: (text, image) => calls.publishGroupAnnouncement(send, target.group_id, text, image, likeSession),
        remove: id => calls.deleteGroupAnnouncement(send, target.group_id, id, likeSession),
        confirmRemovalByList: true,
      },
      vote: workflowSignal ? {
        signal: workflowSignal,
        async reply(parts, quote, active) {
          const message = encodeOneBotReply(parts, quote ? messageId : undefined);
          return message !== undefined && await calls.sendConfirmed(send, target, message, active) === "confirmed";
        },
      } : undefined,
    })),
    groupVerification: workflowSignal && likeSession && selfId !== undefined && "group_id" in target && event.sub_type !== "anonymous"
      ? bindGroupVerificationScope({ connection: likeSession, workflow: workflowSignal,
        botId: selfId, groupId: target.group_id, actorId: userId,
        accepting: () => groupActions?.canModerateGroups?.() !== false,
        isMaster: () => isMaster(selfId, userId), isProtected: id => groupActions?.isProtectedMaster?.(selfId, id) ?? isMaster(selfId, id),
        transport: {
          adapter: "onebot",
          member: (id, active) => calls.getLiveGroupMember(send, target.group_id, id, true, active),
          async send(reply, active) {
            const message = encodeOneBotReply(reply);
            return message !== undefined && await calls.sendConfirmed(send, target, message, active) === "confirmed";
          },
        },
        kick: (id, active) => calls.kickGroupMember(send, target.group_id, id, active),
      }) : undefined,
    groupMuteRoster: likeSession && "group_id" in target && event.sub_type !== "anonymous" ? async () => {
      if (likeSession.aborted || !await calls.getGroupRole(send, target.group_id, userId, true, likeSession) || likeSession.aborted) return;
      return calls.listMutedMembers(send, target.group_id, likeSession);
    } : undefined,
    groupActivityRoster: likeSession && selfId !== undefined && "group_id" in target && event.sub_type !== "anonymous"
      ? visibility => calls.listGroupActivity(send, target.group_id, selfId, userId, () => isMaster(selfId, userId), likeSession, visibility)
      : undefined,
    groupActivitySignal: likeSession && event.sub_type !== "anonymous" ? likeSession : undefined,
    groupRuleImageDigest: likeSession && selfId !== undefined && "group_id" in target && event.sub_type !== "anonymous"
      ? bindGroupRuleImageDigest(incoming.message, selfId, likeSession, groupActions?.canModerateGroups,
        active => calls.getGroupRole(send, target.group_id, userId, true, active)) : undefined,
    groupListAnnouncements: likeSession && "group_id" in target && event.sub_type !== "anonymous" ? async () => {
      const active = () => !likeSession.aborted && groupActions?.canModerateGroups?.() !== false;
      const role = () => calls.getGroupRole(send, target.group_id, userId, true, likeSession);
      if (!active() || !await role() || !active()) return;
      const announcements = await calls.listGroupAnnouncements(send, target.group_id, likeSession);
      if (announcements && active() && await role() && active()) return announcements;
    } : undefined,
    groupListPendingJoinRequests: workflowSignal && likeSession && selfId !== undefined && "group_id" in target && event.sub_type !== "anonymous"
      ? async () => {
        const signal = AbortSignal.any([workflowSignal, likeSession]);
        const active = () => !signal.aborted && groupActions?.canModerateGroups?.() !== false;
        const authorize = () => groupMayReadPendingJoins(id => calls.getGroupRole(send, target.group_id, id, true, signal), selfId, userId, active);
        if (!await authorize()) return;
        const list = await calls.listPendingGroupJoin(send, target.group_id, signal);
        if (list && await authorize()) return list;
      } : undefined,
    listPendingGroupInvitations: privateGroupSignal && attachmentSession && selfId !== undefined && !noticeAttachment ? async () => {
      const signal = AbortSignal.any([privateGroupSignal, attachmentSession.signal]);
      const active = () => !signal.aborted && isMaster(selfId, userId);
      if (!active()) return;
      const list = await calls.listPendingGroupInvitations(send, selfId, signal);
      if (active()) return list;
    } : undefined,
    listPendingFriendRequests: privateGroupSignal && attachmentSession && selfId !== undefined && !noticeAttachment ? async () => {
      if (!privateGroupSignal.aborted && !attachmentSession.signal.aborted && isMaster(selfId, userId)) return calls.listObservedFriendRequests();
    } : undefined,
    reviewAllPendingFriendRequests: ownerSignal && ownerRequestActive && messageId !== undefined && friendRequestReviewClaim && selfId !== undefined ? approve =>
      calls.reviewObservedOwnerRequests("friend", ownerRequestActive, ownerSignal, (flag, pending) =>
        decideOneBotRequest(friendRequestReviewClaim, selfId, flag, () => ownerRequestActive() && pending(),
          () => calls.reviewFriendRequest(send, flag, approve, undefined, ownerSignal))) : undefined,
    reviewAllPendingGroupInvitations: ownerSignal && ownerRequestActive && messageId !== undefined && invitationReviewClaim && selfId !== undefined ? approve =>
      calls.reviewObservedOwnerRequests("invite", ownerRequestActive, ownerSignal, (flag, pending) =>
        decideOneBotRequest(invitationReviewClaim, selfId, flag, () => ownerRequestActive() && pending(),
          () => calls.reviewGroupRequest(send, flag, "invite", approve, undefined, ownerSignal))) : undefined,
    sendOwnerFriendReply: ownerFriendReply,
    sendQuotedOwnerFriendReply: friendNoticeReceipts && ownerFriendReply && ownerSignal && quotedId !== undefined && selfId !== undefined
      ? bindQuotedOwnerFriendReply(friendNoticeReceipts, { adapter: "onebot", account: selfId, owner: userId, message: quotedId },
        () => !ownerSignal.aborted && isMaster(selfId, userId), async () => {
          if (!await calls.isNapCat(send, ownerSignal)) return lookupReply?.();
          const quote = await calls.readPrivateHistoryMessage(send, userId, quotedId, ownerSignal);
          if (quote?.self_id !== selfId || quote.user_id !== selfId || quote.message_type !== "private" || quote.sub_type !== "friend" ||
              !isRecord(quote.sender) || quote.sender.user_id !== selfId) return;
          const content = decodeOneBotMessage(quote.message, selfId)?.message;
          if (content) return { user_id: selfId, message: content };
        }, ownerFriendReply) : undefined,
    isFriend: () => messageType === "private" && event.sub_type === "friend"
      ? Promise.resolve(true) : calls.isFriend(send, userId),
    profileLikeFriendship: boundAccount && messageType === "private" && event.sub_type === "friend"
      ? () => Promise.resolve(true)
      : likeSession ? () => calls.friendship(send, userId, likeSession) : undefined,
    getGroupRole: selfId !== undefined && selfId === connectedBotId
      ? (id) => isId(id) ? calls.getGroupRole(send, id, userId, true) : Promise.resolve(undefined)
      : undefined,
    readKeywordGroupMemberName: boundAccount && attachmentSession && !noticeAttachment
      ? async (group, member, workflow) => {
        const active = AbortSignal.any([attachmentSession.signal, workflow]);
        if (!isId(group) || !isId(member) || active.aborted ||
            ("group_id" in target ? target.group_id !== group : event.sub_type !== "friend")) return;
        return (await calls.getLiveGroupMember(send, group, member, true, active))?.name;
      } : undefined,
    setGroupCard: boundAccount && owner && attachmentSession && display && !noticeAttachment &&
        (messageType === "group" || event.sub_type === "friend") ? bindGroupCard({
      botId: selfId,
      groupId: "group_id" in target ? target.group_id : undefined,
      message: incoming.message,
      active: () => !display.closed && !attachmentSession.signal.aborted && isMaster(selfId, userId),
      memberRole: (groupId, id) => calls.getGroupRole(send, groupId, id, true),
      write: (groupId, id, card) => calls.setGroupCard(send, groupId, id, card),
    }) : undefined,
    listCheckinGroupMembers,
    listCurrentGroupMembers: attachmentSession && !noticeAttachment ? listCheckinGroupMembers : undefined,
    [legacyGroupMemberRoster]: likeSession && event.sub_type === "normal" ? listCurrentRoster : undefined,
    [groupExportSession]: boundAccount && attachmentSession && display?.closed === false && !noticeAttachment &&
      (messageType === "group" ? event.sub_type !== "anonymous" : event.sub_type === "friend") ? (groupId, active) => {
      const signal = AbortSignal.any([active, attachmentSession.signal]);
      return signal.aborted || display.closed ? Promise.resolve(undefined) : calls.listExportedGroupMembers(send, groupId, signal);
    } : undefined,
    [ownGroupCardSession]: boundAccount && owner && !noticeAttachment && (messageType === "group" || event.sub_type === "friend")
      ? () => connection?.ownGroupCardAccount?.(() => isMaster(selfId, userId)) : undefined,
    forward: selfId === undefined ? undefined : async (nodes, senderName, options) => {
      const messages = encodeOneBotForward(nodes, selfId, senderName);
      if (!messages) return false;
      const recall = replyRecallSeconds(options?.recallMsg);
      if (senderName === undefined && recall === undefined) return calls.sendForward(send, target, messages);
      const result = await calls.sendForwardConfirmed(send, target, messages, attachmentSession?.signal, recall);
      if (result === "unknown") throw new Error("OneBot 合并转发结果未确认。");
      return result === "confirmed";
    },
    uploadFile: boundAccount && attachmentSession && display?.closed === false
      ? (file) => display.closed || attachmentSession.signal.aborted ? Promise.resolve("rejected") : calls.uploadFile(send, target, file)
      : undefined,
    [delegationSession]: boundAccount && attachmentSession && display?.closed === false ? {
      signal: attachmentSession.signal,
      groups: async () => (await calls.listGroups(send)).map(group => group.id),
      members: async (id) => (await calls.listMemberDisplay(send, id, true)).map(member => member.id),
      readRoster,
      isFriend: (id) => calls.isFriend(send, id),
      memberRole: (groupId, id) => calls.getGroupRole(send, groupId, id, true),
      botMute: async (groupId) => mutes?.forMessage(groupId, selfId, () => calls.getGroupRole(send, groupId, selfId, true)),
      async send({ groupId, userId }, reply) {
        const message = encodeOneBotReply(reply);
        if (display.closed || attachmentSession.signal.aborted || message === undefined) return "rejected";
        return calls.sendConfirmed(send, groupId === undefined ? { user_id: userId } : { group_id: groupId }, message);
      },
    } : undefined,
    [sendSessionMedia]: boundAccount && attachmentSession && display?.closed === false ? async (url, name, type) => {
      if (display.closed || attachmentSession.signal.aborted) return "rejected";
      if (type === "file") return calls.uploadFileUri(send, target, url, name);
      const message = encodeOneBotReply({ type, data: { file: url, name } });
      return message ? calls.sendConfirmed(send, target, message) : "rejected";
    } : undefined,
    sendMusicCard: boundAccount && attachmentSession && display?.closed === false ? async (card) => {
      if (display.closed || attachmentSession.signal.aborted) return "rejected";
      const message = encodeOneBotMusicCard(card);
      return message ? calls.sendConfirmed(send, target, message) : "rejected";
    } : undefined,
    reviewGroupRequest: messageType === "private" && owner && selfId !== undefined
      ? (flag, type, approve, reason) => {
        if (type === "invite" && invitationReviewClaim) {
          if (!ownerRequestActive) return Promise.resolve(false);
          return confirmedOneBotRequest(decideOneBotRequest(invitationReviewClaim, selfId, flag, ownerRequestActive,
            () => calls.reviewGroupRequest(send, flag, type, approve, reason, ownerSignal)));
        }
        return confirmJoinReview(type === "add" ? joinReview : undefined,
          { adapter: "onebot", botId: selfId, flag }, () => calls.reviewGroupRequest(send, flag, type, approve, reason));
      }
      : undefined,
    groupReviewQuotedRequest: joinReview && lookupReply && likeSession && event.sub_type !== "anonymous" &&
      quotedId !== undefined && selfId !== undefined && "group_id" in target
      ? approve => {
        const active = () => !likeSession.aborted && groupActions?.canModerateGroups?.() !== false;
        return joinReview.quoted({ adapter: "onebot", botId: selfId, groupId: target.group_id, messageId: quotedId }, {
          active,
          async verifyNotice() { return (await lookupReply())?.user_id === selfId; },
          async authorize() {
            return await groupOperatorAuthority(id => calls.getGroupRole(send, target.group_id, id, true, likeSession),
              selfId, userId, () => isMaster(selfId, userId), active) !== undefined;
          },
          verifyPending: origin => origin.adapter === "onebot" ? calls.verifyPendingGroupJoin(send, origin, likeSession)
            : Promise.resolve("unavailable"),
          async submit(origin) {
            return await calls.reviewGroupRequest(send, origin.flag, "add", approve) ? "confirmed" : "rejected";
          },
        });
      } : undefined,
    recallReply: owner && selfId === connectedBotId && temporaryMessageId !== undefined &&
        (incoming.reply_id === undefined || quotedId === temporaryMessageId)
      ? async () => isMaster(selfId, userId) ? [await calls.recallMessage(send, temporaryMessageId, attachmentSession?.signal)] : undefined
      : undefined,
    lookupReply,
    lookupMediaReply: lookupReply && quotedId !== undefined && selfId !== undefined && attachmentSession
      ? active => readOneBotQuote(calls, send, quotedId, selfId, target, AbortSignal.any([attachmentSession.signal, active]), true)
      : undefined,
    reply(reply, quote = false, options = {}) {
      const mention = options.at === true ? userId : options.at;
      const body = messageType === "group" && (isId(mention) || typeof mention === "string" && /^([1-9]\d*|all)$/u.test(mention))
        ? [segment.at(mention), "\n", ...(Array.isArray(reply) ? reply : [reply])] : reply;
      const message = encodeOneBotReply(body, quote ? messageId : undefined);
      if (message === undefined) return false;

      const params = { message_type: messageType, ...target, message, auto_escape: true };
      const recall = replyRecallSeconds(options.recallMsg);
      const onDelivered = options.onDelivered;
      const onOwnReply = options.onOwnReply;
      const report = (onDelivered || onOwnReply) && boundAccount && attachmentSession && !attachmentSession.signal.aborted
        ? async (id: number) => {
          const signal = attachmentSession.signal;
          if (oneBotMessageId(id) === undefined || signal.aborted) return;
          if (onOwnReply && id !== messageId && id !== quotedId) {
            await notifyOwnReply(onOwnReply, () => signal.aborted ? Promise.resolve("unknown") : calls.recallMessage(send, id, signal));
          }
          await notifyReplyDelivery(onDelivered, id);
        }
        : undefined;
      if (recall !== undefined || report) {
        return calls.replyWithReceipt(send, params, recall, options.recallOriginal === false ? undefined : messageId, report);
      }
      return send({ action: "send_msg", params });
    },
  };
  if (lookupReply && attachmentSession && boundAccount && selfId !== undefined && temporaryMessageId !== undefined &&
      quotedId !== undefined && quotedId !== temporaryMessageId && event.sub_type !== "anonymous" &&
      (!sender || sender.user_id === undefined || sender.user_id === userId) &&
      (("group_id" in target && likeSession) || (event.sub_type === "friend" && !isId(event.group_id)))) {
    quotedRecallSessions.set(inbound, bindQuotedRecall({
      account: selfId, actor: userId, peer: "group_id" in target ? target.group_id : userId, group: "group_id" in target,
      command: temporaryMessageId, quoted: quotedId, signal: attachmentSession.signal,
      readQuote: () => readOneBotQuote(calls, send, quotedId, selfId, target, attachmentSession.signal),
      readRole: () => "group_id" in target
        ? calls.getGroupRole(send, target.group_id, userId, true, attachmentSession.signal) : Promise.resolve(undefined),
      recall: id => calls.recallMessage(send, id, attachmentSession.signal),
      groupFile(source) {
        if (!("group_id" in target)) return;
        const file = quotedGroupFile(source, "onebot");
        if (!file) return;
        const group = target.group_id;
        const transport = attachmentSession.signal;
        return { id: file.id, async locate(active) {
          const found = await findQuotedGroupFile(group, file, "onebot", transport, active,
            (folder, signal) => calls.readGroupFiles(send, group, folder, signal));
          const busId = found?.busId;
          if (busId !== undefined) return () => calls.deleteGroupFile(send, group, file.id, busId, transport);
        } };
      },
    }));
  }
  if (likeSession && selfId !== undefined && "group_id" in target && event.sub_type !== "anonymous") {
    const checkRole = (active: AbortSignal, subject?: number, permitAdmin?: boolean) =>
      canModerateGroupSubject(id => calls.getGroupRole(send, target.group_id, id, true, active), selfId, subject, permitAdmin);
    const nativeId = oneBotMessageId(messageId);
    bindGroupModeration(inbound, {
      signal: likeSession,
      canModerate: active => checkRole(active, userId),
      act: active => calls.kickGroupMember(send, target.group_id, userId, active),
      memberMessage: nativeId === undefined ? undefined : {
        readImageMd5: bindSingleGroupImageDigest(incoming.message),
        mixedImageParts: bindMixedGroupImageParts(incoming.message),
        canAct: active => checkRole(active, userId, false),
        botCanAct: active => checkRole(active),
        mute: (seconds, active) => calls.setGroupMute(send, target.group_id, userId, seconds, active),
        recall: active => calls.recallMessage(send, nativeId, active),
        async send(reply, active) {
          const message = encodeOneBotReply(reply);
          return message !== undefined && await calls.sendConfirmed(send, target, message, active) === "confirmed";
        },
      },
    });
  }
  const reservation = fileNotice?.reserve?.(inbound);
  await dispatch(reservation && fileNotice ? {
    ...inbound, [chatFileRelaySource]: { ...fileNotice.source, reservation },
  } : inbound);
}

export function startOneBot(
  dispatch: (event: BotEvent) => Promise<void>,
  options: GroupActionPolicy & OwnerNoticeOptions & {
    hostname: string;
    port: number;
    tls?: Bun.TLSOptions;
    auth: Headers;
    isMaster: (bot: number, user: number) => boolean;
    masterIds: (bot: number) => readonly number[];
    groups: OneBotGroups;
    prewarmGroupMembers?: boolean;
    accepting?: () => boolean;
    onBind?: (botId: number, signal?: AbortSignal) => void;
    onLegacySignal?: (event: OneBotLegacySignal, signal: AbortSignal) => void;
    onSent?: (identity: MessageIdentity, message?: unknown) => void;
    http?: (request: Request) => Response | Promise<Response>;
  },
) {
  const authenticated = [...options.auth].length > 0;

  function sender(socket: Bun.ServerWebSocket<ConnectionData>, source: MessageIdentity): Send {
    return (frame) => {
      const sent = sendFrame(socket, JSON.stringify(frame));
      if (sent && options.onSent) sentMessage(frame, source, options.onSent);
      return sent;
    };
  }

  async function handleLegacySignal(event: Record<string, unknown>, send: Send, connection: ConnectionData) {
    if (options.accepting?.() === false) return;
    const { self_id, user_id, time, notice_type } = event;
    if (!isId(self_id) || !isId(user_id) || !isId(time)) return;
    const signal = groupActionSignal(connection, self_id);
    if (!signal) return;
    const reply: MessageEvent["reply"] = (body) => {
      const message = encodeOneBotReply(body);
      return !signal.aborted && message !== undefined && send({
        action: "send_msg", params: { message_type: "private", user_id, message, auto_escape: true },
      });
    };
    if (notice_type === "bot_offline") {
      if (user_id !== self_id || (event.group_id !== undefined && event.group_id !== 0) || typeof event.message !== "string" ||
          (event.tag !== undefined && (typeof event.tag !== "string" || event.tag.length > 256)) ||
          event.message.length > 2_000 || connection.receivedOffline) return;
      connection.receivedOffline = true;
      const tag = sanitizeRuntimeLog(event.tag || "账号下线", 256);
      const message = sanitizeRuntimeLog(event.message);
      options.onLegacySignal?.({ post_type: "system", notice_type: "offline", self_id, user_id, time, tag, message,
        reply: () => false }, signal);
      await notifyVerifiedFriendOwners(connection.calls, send, self_id,
        active => selectNoticeOwners(options, self_id, active, options.isMaster),
        `[${self_id}] ${tag}：${message}`, signal);
    } else {
      const { group_id, event_type, status_text } = event;
      if (group_id !== 0 || typeof event_type !== "number" || !Number.isSafeInteger(event_type) || event_type < 0 ||
          typeof status_text !== "string" || status_text.length > 512) return;
      const end = event_type !== 1;
      const message = status_text || (end ? "对方结束输入..." : "对方正在输入...");
      options.onLegacySignal?.({ post_type: "internal", notice_type: "input", sub_type: "input_status",
        self_id, user_id, time, group_id, event_type, status_text, end, message, reply }, signal);
    }
  }

  function bind(socket: Bun.ServerWebSocket<ConnectionData>, botId: number) {
    socket.data.receivedOffline = false;
    socket.data.botId = botId;
    const send = sender(socket, { self_id: botId });
    const display = new OneBotMemberDisplay((groupId) => socket.data.calls.listMemberDisplay(send, groupId));
    socket.data.display = display;
    const signal = socket.data.attachmentSession?.signal;
    const { calls } = socket.data;
    if (signal) {
      socket.data.ownGroupCardAccount = authorize => bindOwnGroupCard({
        adapter: "onebot", botId, signal,
        groups: async () => (await calls.listGroups(send, signal)).map(({ id }) => id),
        loginNickname: () => calls.loginNickname(send, botId, signal),
        read: groupId => calls.readOwnGroupCard(send, groupId, botId, signal),
        write: (groupId, card) => calls.setGroupCard(send, groupId, botId, card, signal),
      }, () => !display.closed && (authorize?.() ?? true));
    }
    socket.data.detach = options.groups.connect(botId, {
      calls: socket.data.calls,
      send,
      ownGroupCardAccount: socket.data.ownGroupCardAccount?.(),
      retireMemberDisplay: () => {
        display.close();
        socket.data.attachmentSession?.abort();
      },
    });
    options.onBind?.(botId, signal);
    if (options.prewarmGroupMembers) {
      socket.data.joinRoster = new Map();
      const skipped = new Set<number>();
      socket.data.skipInitialRoster = skipped;
      void (async () => {
        try {
          const groups = await socket.data.calls.listGroups(send);
          for (const groupId of new Set(groups.map(({ id }) => id))) {
            if (display.closed) break;
            if (!skipped.has(groupId)) await display.warm(groupId);
          }
        } catch {
          // Roster prewarming is optional and does not affect the connection.
        } finally {
          socket.data.skipInitialRoster = undefined;
        }
      })();
    }
  }

  return Bun.serve<ConnectionData>({
    hostname: options.hostname,
    port: options.port,
    tls: options.tls,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      // TRSS routed reverse WebSockets by the first path segment.
      const legacyUpgrade = path.startsWith("/OneBotv11/") && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
      if (path !== "/OneBotv11" && path !== "/OneBotv11/" && !legacyUpgrade) {
        return options.http?.(request) ?? new Response(null, { status: 404 });
      }
      if (options.accepting?.() === false) return new Response(null, { status: 503 });
      if (!authorized(request, options.auth)) {
        return new Response(null, { status: 401 });
      }
      if (request.headers.get("X-Client-Role")?.toLowerCase() !== "universal") {
        return new Response("需要 OneBot 11 Universal 连接。", { status: 400 });
      }
      const header = request.headers.get("X-Self-ID");
      const id = header !== null && /^[1-9]\d*$/u.test(header) ? Number(header) : undefined;
      const data = { calls: new OneBotCalls(), mutes: new OneBotMutes(), botId: isId(id) ? id : undefined,
        attachmentSession: authenticated || isLoopback(server.requestIP(request)?.address) ? new AbortController() : undefined };
      if (!server.upgrade(request, { data })) {
        return new Response(null, { status: 426 });
      }
    },
    websocket: {
      open(socket) {
        if (socket.data.botId !== undefined) bind(socket, socket.data.botId);
      },
      async message(socket, input) {
        if (typeof input !== "string") return;
        let message: unknown;
        try {
          message = JSON.parse(input);
        } catch {
          return;
        }
        const { calls, botId, mutes, attachmentSession } = socket.data;
        if (!isRecord(message) || calls.receive(message)) return;
        if (botId !== undefined && isId(message.self_id) && message.self_id !== botId) return;
        if (message.post_type === "meta_event") {
          if (botId === undefined && isId(message.self_id) &&
              (message.meta_event_type === "lifecycle" || message.meta_event_type === "heartbeat")) {
            bind(socket, message.self_id);
          }
          return;
        }

        try {
          const send = sender(socket, {
            self_id: isId(message.self_id) ? message.self_id : botId,
            user_id: isId(message.user_id) ? message.user_id : undefined,
            group_id: isId(message.group_id) ? message.group_id : undefined,
          });
          if (message.post_type === "notice") {
            if (isId(message.group_id) && isId(message.self_id)) mutes.observe(message.group_id, message.self_id, message);
            if (message.notice_type === "group_recall" || message.notice_type === "friend_recall") {
              void dispatchMessageRecallNotice(dispatch, send, message, socket.data, options.isMaster)
                .catch(() => console.error("处理 OneBot 撤回通知失败。"));
            }
            if (message.notice_type === "group_admin" || message.notice_type === "group_ban") {
              void dispatchGroupCompatibilityNotice(dispatch, send, message, socket.data, options.isMaster)
                .catch(() => console.error("处理 OneBot 群管理通知失败。"));
            }
            if (message.notice_type === "group_admin") {
              const { self_id, group_id, user_id, sub_type, time } = message;
              if (!options.onGroupOwnerAdminNotice || !isId(self_id) || !isId(group_id) || !isId(user_id) || !isId(time) ||
                  (sub_type !== "set" && sub_type !== "unset")) return;
              const signal = groupActionSignal(socket.data, self_id);
              if (!signal) return;
              options.onGroupOwnerAdminNotice({ adapter: "onebot", botId: self_id, groupId: group_id, userId: user_id, time,
                set: sub_type === "set", signal,
                notifyOwners: (reply, active) => notifyVerifiedFriendOwners(calls, send, self_id,
                  scope => selectNoticeOwners(options, self_id, scope, options.isMaster), reply, AbortSignal.any([signal, active])),
              });
            } else if (message.notice_type === "group_recall" && options.onGroupRecall) {
              const { self_id, user_id, operator_id, group_id, time } = message;
              const messageId = oneBotMessageId(message.message_id);
              if (!isId(self_id) || !isId(user_id) || !isId(operator_id) || !isId(group_id) || !isId(time) || messageId === undefined ||
                  self_id === user_id || self_id === operator_id) return;
              const signal = groupActionSignal(socket.data, self_id);
              if (!signal) return;
              const memberName = async (id: number, active: AbortSignal) =>
                (await calls.getLiveGroupMember(send, group_id, id, true, active))?.name;
              options.onGroupRecall({ adapter: "onebot", botId: self_id, userId: user_id, groupId: group_id, operatorId: operator_id,
                messageId, time, signal,
                async describe(active) {
                  const [groupName, nickname, operatorName] = await Promise.all([
                    calls.getGroupName(send, group_id, active, true), memberName(user_id, active),
                    operator_id === user_id ? undefined : memberName(operator_id, active),
                  ]);
                  return { groupName, nickname, operatorName };
                },
                async notifyOwners(summary, original, nickname, active, followup) {
                  if (followup !== undefined) {
                    await notifyVerifiedFriendOwners(calls, send, self_id, scope => selectNoticeOwners(options, self_id, scope, options.isMaster),
                      summary, AbortSignal.any([signal, active]), { followup, allowFollowup: id => options.isMaster(self_id, id) });
                    return;
                  }
                  const message = encodeOneBotReply(summary);
                  const nodes = encodeOneBotForward([original], user_id, nickname ?? String(user_id));
                  if (active.aborted || message === undefined || !nodes) return;
                  const friends = new Set((await calls.listFriendProfiles(send, active).catch(() => [])).map(profile => String(profile.user_id)));
                  const owners = (await selectNoticeOwners(options, self_id, active, options.isMaster))
                    .filter(owner => owner !== self_id && friends.has(String(owner)));
                  await Promise.all(owners.map(async owner => {
                    if (active.aborted || !options.isMaster(self_id, owner)) return;
                    const target = { user_id: owner };
                    if (await calls.sendConfirmed(send, target, message, active) !== "confirmed" || active.aborted || !options.isMaster(self_id, owner)) return;
                    if (await calls.sendForwardConfirmed(send, target, nodes, active) === "rejected" && !active.aborted && options.isMaster(self_id, owner)) {
                      const fallback = encodeOneBotReply(typeof original === "string" ? `撤回消息：${original}` : ["撤回消息：", ...original]);
                      if (fallback !== undefined) await calls.sendConfirmed(send, target, fallback, active);
                    }
                  }));
                },
              });
            } else if (message.notice_type === "friend_recall" && options.onFriendRecall) {
              const { self_id, user_id, operator_id, time } = message;
              const messageId = oneBotMessageId(message.message_id);
              if (!isId(self_id) || !isId(user_id) || self_id === user_id || !isId(time) || messageId === undefined ||
                  isId(message.group_id) || (operator_id !== undefined && operator_id !== user_id)) return;
              const signal = groupActionSignal(socket.data, self_id);
              if (!signal) return;
              options.onFriendRecall({ adapter: "onebot", botId: self_id, userId: user_id, messageId, time, signal,
                notifyOwners: (reply, workflow, followup) => notifyVerifiedFriendOwners(calls, send, self_id,
                  scope => selectNoticeOwners(options, self_id, scope, options.isMaster), reply, AbortSignal.any([signal, workflow]),
                  { source: followup === undefined ? undefined : user_id, followup, allowFollowup: id => options.isMaster(self_id, id) }),
              });
            } else if (message.notice_type === "friend_add") {
              const { self_id, user_id, time, group_id } = message;
              if (!isId(self_id) || !isId(user_id) || self_id === user_id) return;
              const signal = groupActionSignal(socket.data, self_id);
              if (!signal) return;
              if (group_id === undefined || group_id === 0) {
                void dispatch({
                  post_type: "notice", notice_type: "friend", sub_type: "add", adapter: "onebot", self_id, user_id,
                  time: isId(time) ? time : undefined, isGroup: false, isPrivate: true, isMaster: options.isMaster(self_id, user_id),
                  reply(reply) {
                    if (signal.aborted) return false;
                    const content = encodeOneBotReply(reply);
                    return content !== undefined && send({
                      action: "send_msg", params: { message_type: "private", user_id, message: content, auto_escape: true },
                    });
                  },
                }).catch(() => console.error("处理 OneBot 好友新增通知失败。"));
              }
              if (!options.onFriendRelationship || !isId(time)) return;
              let profiles: ReturnType<OneBotCalls["listFriendProfiles"]> | undefined;
              const readProfiles = (workflow: AbortSignal) =>
                profiles ??= calls.listFriendProfiles(send, AbortSignal.any([signal, workflow])).catch(() => []);
              options.onFriendRelationship({ botId: self_id, userId: user_id, time, kind: "increase", signal,
                async readNickname(workflow) {
                  const entry = (await readProfiles(workflow)).find(profile => String(profile.user_id) === String(user_id));
                  return stringField(entry?.nickname);
                },
                async notifyOwners(reply, workflow) {
                  const active = AbortSignal.any([signal, workflow]);
                  const peers = new Set((await readProfiles(active)).map(profile => String(profile.user_id)));
                  const owners = (await selectNoticeOwners(options, self_id, active, options.isMaster)).filter(id => peers.has(String(id)));
                  return notifyOwnerReplies(calls, send, self_id, owners, reply, active);
                },
              });
            } else if (message.notice_type === "group_card" || message.notice_type === "essence" ||
                message.notice_type === "group_msg_emoji_like" ||
                (message.notice_type === "notify" && (message.sub_type === "group_name" || message.sub_type === "title" || message.sub_type === "honor"))) {
              await dispatchGroupCompatibilityNotice(dispatch, send, message, socket.data, options.isMaster);
            } else if (message.notice_type === "notify" && message.sub_type === "profile_like") {
              await dispatchProfileLike(dispatch, send, message, socket.data, options.isMaster);
            } else if (message.notice_type === "bot_offline" || (message.notice_type === "notify" && message.sub_type === "input_status")) {
              await handleLegacySignal(message, send, socket.data);
            } else if (message.notice_type === "group_ban" && (options.onMemberMute || options.onGroupOwnerBanNotice)) {
              const { self_id, group_id, user_id, operator_id, time, duration, sub_type } = message;
              if (!isId(self_id) || !isId(group_id) || !isId(user_id) || !isId(operator_id) ||
                  !isId(time) || !isMemberMuteDuration(duration) ||
                  (sub_type !== "ban" && sub_type !== "lift_ban") || (sub_type === "ban") !== (duration > 0)) return;
              const signal = groupActionSignal(socket.data, self_id);
              if (!signal) return;
              if (user_id === self_id) {
                options.onGroupOwnerBanNotice?.({ adapter: "onebot", botId: self_id, groupId: group_id, userId: user_id,
                  operatorId: operator_id, time, duration, signal,
                  notifyOwners: (reply, active) => notifyVerifiedFriendOwners(calls, send, self_id,
                    scope => selectNoticeOwners(options, self_id, scope, options.isMaster), reply, AbortSignal.any([signal, active])),
                });
              }
              options.onMemberMute?.({ self_id, group_id, user_id, operator_id, time, duration, signal,
                canModerate: active => canModerateGroupSubject(id => calls.getGroupRole(send, group_id, id, true, active), self_id, user_id),
                unmute: active => calls.setGroupMute(send, group_id, user_id, 0, active),
                async reply(reply) {
                  const content = encodeOneBotReply(reply);
                  return content !== undefined &&
                    await calls.replyWithConfirmation(send, { message_type: "group", group_id, message: content, auto_escape: true });
                },
              });
            } else if (message.notice_type === "group_upload") {
              if (!attachmentSession || botId === undefined || message.self_id !== botId || !isId(message.user_id) ||
                  !isId(message.group_id) || !isRecord(message.file)) return;
              const attachment = incomingAttachment(attachmentSession.signal, calls, send, { group_id: message.group_id }, message.file,
                "group_upload");
              if (attachment) {
                const reference = attachmentId(message.file.id, attachment.name);
                await dispatchMessage(dispatch, send, {
                  ...message, post_type: "message", message_type: "group", sub_type: "normal", message_id: undefined,
                  raw_message: `[文件：${attachment.name}]`,
                  message: [{ type: "file", data: message.file }],
                }, calls, options.isMaster, socket.data, attachment, undefined, reference ? {
                  source: { signal: attachmentSession.signal, reference, notice: true }, reserve: options.reserveFileNotice,
                } : undefined);
              }
              await dispatchFileUploadNotice(dispatch, send, message, socket.data, options.isMaster);
            } else if (message.notice_type === "offline_file" && isId(message.self_id) &&
                !message.group_id && isRecord(message.file)) {
              const attachment = isId(message.user_id) && message.self_id === botId && attachmentSession
                ? incomingAttachment(attachmentSession.signal, calls, send, { user_id: message.user_id }, message.file, "offline_file")
                : undefined;
              const reference = attachment && (attachmentId(message.file.file_id, attachment.name) ??
                (typeof message.file.url === "string" && message.file.url.length <= 8192
                  ? `url:${createHash("sha256").update(message.file.url).digest("hex")}` : undefined));
              await dispatchMessage(dispatch, send, {
                ...message, post_type: "message", message_type: "private", sub_type: "friend",
                raw_message: attachment && `[文件：${attachment.name}]`,
                message: [{ type: "file", data: message.file }],
              }, calls, options.isMaster, undefined, attachment, undefined, reference && attachmentSession ? {
                source: { signal: attachmentSession.signal, reference, notice: true }, reserve: options.reserveFileNotice,
              } : undefined);
              await dispatchFileUploadNotice(dispatch, send, message, socket.data, options.isMaster);
            } else if (message.notice_type === "notify" && message.sub_type === "poke") {
              if (isId(message.group_id)) await dispatchGroupPoke(dispatch, send, message, socket.data, options.isMaster);
              else if (!message.group_id) await dispatchFriendPoke(dispatch, send, message, socket.data, options);
            } else if (message.notice_type === "notify" && message.sub_type === "poke_recall") {
              await dispatchPokeRecall(dispatch, send, message, socket.data, options.isMaster);
            } else {
              await dispatchGroupNotice(dispatch, send, message, calls, options, socket.data);
            }
          } else if (message.post_type === "request") {
            await dispatchRequest(dispatch, send, message, calls, options, socket.data);
          } else {
            await dispatchMessage(dispatch, send, message, calls, options.isMaster, socket.data, undefined, options);
          }
        } catch {
          console.error("处理 OneBot 事件失败。");
        }
      },
      close(socket) {
        socket.data.detach?.();
        socket.data.display?.close();
        socket.data.attachmentSession?.abort();
        socket.data.calls.close();
      },
    },
  });
}
