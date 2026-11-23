import { isGeneratedImage } from "@lotus-yunzai/skia/generated-image";
import { chatFileRelaySource, type ChatFile, type ChatFileRelaySource, type ChatFileResult, type IncomingChatFile } from "./chat-files.ts";
import { sendSessionMedia, type MediaDelivery, type SendSessionMedia } from "./media-delivery.ts";
import { delegationSession, type DelegationSession } from "./command-delegation.ts";
import { ownerContactListSession, type OwnerContactListSession } from "./owner-contact-list.ts";
import { groupExportSession, type GroupExportSession } from "./group-member-export.ts";
import { manualGroupLeaveSession, type ManualGroupLeaveSession } from "./manual-group-leave.ts";
import { ownGroupCardSession, type OwnGroupCardAccount } from "./adapters/own-group-card.ts";
import { groupAvatarSession, type GroupAvatarSession } from "./adapters/group-avatar.ts";
import { ownerAccountSession, type OwnerAccountSession } from "./adapters/owner-account.ts";
import { qzoneSession, type QzoneSession } from "./adapters/qzone.ts";
import type { MentionLikeTarget } from "./adapters/mention-like.ts";
import type { OwnerFriendReplyBody, OwnerFriendReplyOutcome } from "./adapters/owner-friend-reply.ts";
import type { PendingGroupJoinBatch, PendingGroupJoinDecision, PendingGroupJoinList, QuotedJoinReviewResult } from "./group-join-review.ts";
import type { PendingGroupInvitationDecision, PendingGroupInvitationList, QuotedGroupInvitationDecision } from "./group-invitations.ts";
import type { PendingFriendRequestDecision, PendingFriendRequestList } from "./friend-requests.ts";
import type { OwnerRequestBatchResult } from "../plugins/group/owner-request-batch.ts";
import { friendMessageNoticeSession, type FriendMessageNoticeSession, type QuotedOwnerFriendReplyOutcome } from "./friend-message-notice.ts";
import type { GroupActivityMember, GroupActivityVisibility, GroupAnnouncement, GroupDeleteAnnouncement, GroupKickAction, GroupKickInactiveAction, GroupManageBlacklistAction,
  GroupMuteAction, GroupNotifyAllAction, GroupPublishAnnouncement, GroupVerificationScope, GroupVoteAccess,
  GroupMuteSelfAction, GroupSetAdminAction, GroupSetQuotedEssenceAction, GroupSpecialTitleAction, GroupWholeMuteAction,
  MutedGroupMember, PrivateGroupKick, PrivateGroupMute, PrivateGroupWholeMute } from "./adapters/group-moderation.ts";

export interface MusicCard {
  readonly type: "163" | "qq" | "kugou" | "kuwo" | "migu";
  readonly url: string;
  readonly audio: string;
  readonly title: string;
  readonly content: string;
  readonly singer: string;
  readonly image: string;
}

export type ReadCurrentGroupMembers = () => Promise<readonly { id: number; name?: string }[] | undefined>;

export interface MessageEvent {
  readonly msg: string;
  readonly adapter?: "milky";
  readonly inlineImageByteLimit?: number;
  readonly isNapCat?: (signal: AbortSignal) => Promise<boolean>;
  readonly post_type: "message";
  readonly message_type: "group" | "private" | "terminal";
  readonly sub_type?: string;
  readonly message_id?: number;
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly sender?: Readonly<Record<string, unknown>>;
  readonly member?: { readonly is_admin: boolean; readonly is_owner: boolean };
  readonly botMute?: {
    readonly remainingSeconds?: number;
    readonly allMembers?: boolean;
    readonly isAdmin?: boolean;
    readonly isOwner?: boolean;
  };
  game?: "gs" | "sr" | "zzz";
  isSr?: boolean;
  isGs?: boolean;
  readonly isGroup: boolean;
  readonly isPrivate: boolean;
  readonly isMaster: boolean;
  readonly boundAccount?: boolean;
  readonly privateCredentialSignal?: AbortSignal;
  readonly isOwnerEnrollmentSession?: () => boolean;
  readonly canManageProcess?: boolean;
  readonly [delegationSession]?: DelegationSession;
  readonly [ownerContactListSession]?: OwnerContactListSession;
  readonly [groupExportSession]?: GroupExportSession;
  readonly [manualGroupLeaveSession]?: ManualGroupLeaveSession;
  readonly [friendMessageNoticeSession]?: FriendMessageNoticeSession;
  readonly canDelegate?: boolean;
  readonly delegationSignal?: AbortSignal;
  readonly isDelegated?: boolean;
  readonly onAwaitInput?: () => void;
  readonly likeSelf?: (count: number) => Promise<number>;
  readonly mentionLike?: MentionLikeTarget;
  readonly groupMute?: GroupMuteAction;
  readonly groupMuteSelf?: GroupMuteSelfAction;
  readonly groupWholeMute?: GroupWholeMuteAction;
  readonly groupKick?: GroupKickAction;
  readonly groupKickInactive?: GroupKickInactiveAction;
  readonly groupManageBlacklist?: GroupManageBlacklistAction;
  readonly groupManageWhitelistAutoUnmute?: GroupManageBlacklistAction;
  readonly groupSetSpecialTitle?: GroupSpecialTitleAction;
  readonly groupSetAdmin?: GroupSetAdminAction;
  readonly groupMuteRoster?: () => Promise<readonly MutedGroupMember[] | undefined>;
  readonly groupActivityRoster?: (visibility?: GroupActivityVisibility) => Promise<readonly GroupActivityMember[] | undefined>;
  readonly groupActivitySignal?: AbortSignal;
  readonly groupSetQuotedEssence?: GroupSetQuotedEssenceAction;
  readonly groupNotifyAll?: GroupNotifyAllAction;
  readonly groupReviewQuotedRequest?: (approve: boolean) => Promise<QuotedJoinReviewResult>;
  readonly groupListPendingJoinRequests?: () => Promise<PendingGroupJoinList | undefined>;
  readonly listPendingGroupInvitations?: () => Promise<PendingGroupInvitationList | undefined>;
  readonly reviewPendingGroupInvitation?: (groupId: number, approve: boolean) => Promise<PendingGroupInvitationDecision>;
  readonly reviewAllPendingGroupInvitations?: (approve: boolean) => Promise<OwnerRequestBatchResult>;
  readonly reviewQuotedGroupInvitation?: (approve: boolean) => Promise<QuotedGroupInvitationDecision>;
  readonly listPendingFriendRequests?: () => Promise<PendingFriendRequestList | undefined>;
  readonly reviewPendingFriendRequest?: (userId: number, approve: boolean) => Promise<PendingFriendRequestDecision>;
  readonly reviewAllPendingFriendRequests?: (approve: boolean) => Promise<OwnerRequestBatchResult>;
  readonly sendOwnerFriendReply?: (userId: number, body: OwnerFriendReplyBody) => Promise<OwnerFriendReplyOutcome>;
  readonly sendQuotedOwnerFriendReply?: (body: OwnerFriendReplyBody) => Promise<QuotedOwnerFriendReplyOutcome>;
  readonly groupReviewPendingJoin?: (userId: number, approve: boolean) => Promise<PendingGroupJoinDecision>;
  readonly groupReviewAllPendingJoins?: (approve: boolean) => Promise<PendingGroupJoinBatch>;
  readonly groupListAnnouncements?: () => Promise<readonly GroupAnnouncement[] | undefined>;
  readonly groupPublishAnnouncement?: GroupPublishAnnouncement;
  readonly groupDeleteAnnouncement?: GroupDeleteAnnouncement;
  readonly groupRuleImageDigest?: (signal: AbortSignal) => Promise<string | undefined>;
  readonly groupVote?: GroupVoteAccess;
  readonly groupVerification?: GroupVerificationScope;
  readonly privateGroupMute?: PrivateGroupMute;
  readonly privateGroupWholeMute?: PrivateGroupWholeMute;
  readonly privateGroupKick?: PrivateGroupKick;
  readonly profileLikeImageSignal?: AbortSignal;
  readonly isFriend?: () => Promise<boolean>;
  readonly profileLikeFriendship?: () => Promise<boolean | undefined>;
  readonly getGroupRole?: (groupId: number) => Promise<GroupMembership["botRole"] | undefined>;
  readonly readKeywordGroupMemberName?: (groupId: number, userId: number, signal: AbortSignal) => Promise<string | undefined>;
  readonly setGroupCard?: (card: string, groupId?: number, userId?: number) => Promise<GroupCardResult>;
  readonly setGroupName?: (name: string, groupId?: number) => Promise<"confirmed" | "rejected" | "unknown" | "unavailable">;
  readonly [ownGroupCardSession]?: () => OwnGroupCardAccount | undefined;
  readonly [groupAvatarSession]?: GroupAvatarSession;
  readonly [ownerAccountSession]?: OwnerAccountSession;
  readonly [qzoneSession]?: QzoneSession;
  readonly listCurrentGroupMembers?: ReadCurrentGroupMembers;
  readonly verifyOwnGroupMembership?: (groupId: number, signal: AbortSignal) => Promise<boolean>;
  readonly listCheckinGroupMembers?: ReadCurrentGroupMembers;
  readonly forward?: (nodes: readonly MessageReply[], senderName?: string, options?: Pick<ReplyOptions, "recallMsg">) => Promise<boolean>;
  readonly uploadFile?: (file: ChatFile) => Promise<ChatFileResult>;
  readonly deliverMedia?: (file: MediaDelivery) => Promise<ChatFileResult>;
  readonly sendMusicCard?: (card: MusicCard) => Promise<ChatFileResult>;
  readonly [sendSessionMedia]?: SendSessionMedia;
  readonly attachment?: IncomingChatFile;
  readonly canReadAttachments?: boolean;
  readonly [chatFileRelaySource]?: ChatFileRelaySource;
  readonly attachmentOnly?: boolean;
  readonly reviewGroupRequest?: (flag: string, type: GroupRequestType, approve: boolean, reason?: string) => Promise<boolean>;
  readonly groupRequestScope?: "milky";
  readonly canReviewGroupRequests?: boolean;
  readonly recallReply?: () => Promise<readonly RecallResult[] | undefined>;
  readonly lookupReply?: () => Promise<QuotedMessage | undefined>;
  readonly lookupMediaReply?: (active: AbortSignal) => Promise<QuotedMessage | undefined>;
  readonly raw_message: string;
  readonly message: string | readonly InboundSegment[];
  readonly atBot?: boolean;
  readonly hasAlias?: boolean;
  readonly only_reply_at?: boolean;
  readonly at?: string | number;
  readonly reply_id?: string | number;
  readonly img?: readonly string[];
  readonly file?: InboundSegment;
  readonly reply: (message: MessageReply, quote?: boolean, options?: ReplyOptions) => boolean | Promise<boolean>;
}

export interface QuotedMessage {
  readonly user_id: number;
  readonly attachment?: IncomingChatFile;
  readonly message: readonly InboundSegment[];
}

export type RecallResult = "confirmed" | "rejected" | "unknown";
export type RecallOwnReply = () => Promise<RecallResult>;
export type GroupCardResult = RecallResult | "missing-group" | "insufficient-role";

export interface ReplyOptions {
  readonly at?: boolean | string | number;
  readonly recallMsg?: number;
  readonly recallOriginal?: boolean;
  readonly onDelivered?: (messageId: number) => void | Promise<void>;
  /** Receives a one-use handle to this confirmed reply on its original connection. */
  readonly onOwnReply?: (recall: RecallOwnReply) => void | Promise<void>;
}

export async function notifyOwnReply(callback: NonNullable<ReplyOptions["onOwnReply"]>, recall: RecallOwnReply): Promise<void> {
  let result: Promise<RecallResult> | undefined;
  try {
    await callback(() => result ??= Promise.resolve().then(recall).catch(() => "unknown"));
  } catch {
    console.warn("[消息] 已确认送达，撤回回执记录失败。");
  }
}

export function replyRecallSeconds(seconds: unknown): number | undefined {
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= 120) return seconds;
}

export async function notifyReplyDelivery(callback: ReplyOptions["onDelivered"], messageId: number): Promise<void> {
  if (!callback) return;
  try {
    await callback(messageId);
  } catch {
    console.warn("[消息] 已确认送达，回执记录失败。");
  }
}

export interface GroupNotice {
  readonly post_type: "notice";
  readonly notice_type: "group";
  readonly sub_type: "increase" | "decrease";
  readonly time?: number;
  readonly action_sub_type?: string;
  readonly increase_type?: string;
  readonly decrease_type?: string;
  readonly self_id: number;
  readonly user_id: number;
  readonly group_id: number;
  readonly operator_id?: number;
  readonly inviter_id?: number;
  readonly group_name?: string;
  readonly getGroupName?: () => Promise<string | undefined>;
  readonly inspectAutoQuit?: (maxMembers: number, signal?: AbortSignal) => Promise<GroupMembership | undefined>;
  readonly leaveGroup?: () => Promise<boolean>;
  readonly nickname?: string;
  readonly member?: { readonly card?: string; readonly nickname?: string };
  readonly dismiss?: boolean;
  readonly isGroup: true;
  readonly isPrivate: false;
  readonly isMaster: boolean;
  readonly reply: MessageEvent["reply"];
}

export interface GroupMembership {
  readonly memberIds: readonly number[];
  readonly botRole: "member" | "admin" | "owner";
}

export type GroupRequestType = "add" | "invite";

export interface GroupRequest {
  readonly post_type: "request";
  readonly request_type: "group";
  readonly sub_type: GroupRequestType;
  readonly self_id: number;
  readonly user_id: number;
  readonly group_id: number;
  readonly flag: string;
  readonly groupRequestScope?: "milky";
  readonly inviter_id?: number;
  readonly comment?: string;
  readonly nickname?: string;
  readonly group_name?: string;
  readonly isGroup: true;
  readonly isPrivate: false;
  readonly isMaster: boolean;
  readonly approve: (approve?: boolean, reason?: string) => Promise<boolean>;
  readonly replyToApplicant?: MessageEvent["reply"];
  readonly deferManualReview?: (review: () => Promise<void>) => void;
  readonly notifyMasters: (message: string) => Promise<number>;
  readonly notifyRequestOwners?: (message: string, rich?: { readonly reply: MessageReply; readonly signal: AbortSignal }) => Promise<number>;
  readonly notifyOwners?: (reply: MessageReply, signal: AbortSignal) => Promise<number>;
  readonly notifyJoinRequestOwners?: (ordinaryMessage: string, actions: string) => Promise<number>;
  readonly notifyInvitationRequestOwners?: (ordinaryMessage: string, actions: string) => Promise<number>;
  readonly reply: MessageEvent["reply"];
}

export interface FriendRequest {
  readonly post_type: "request";
  readonly request_type: "friend";
  readonly sub_type: "add";
  readonly self_id: number;
  readonly user_id: number;
  readonly flag: string;
  readonly adapter?: "milky";
  readonly comment?: string;
  readonly nickname?: string;
  readonly source?: string;
  readonly isGroup: false;
  readonly isPrivate: true;
  readonly isMaster: boolean;
  readonly approvalSignal?: AbortSignal;
  readonly approve: (approve?: boolean, remark?: string) => Promise<boolean>;
  readonly notifyMasters: (message: string) => Promise<number>;
  readonly notifyOwners?: (message: MessageReply, signal: AbortSignal) => Promise<number>;
  readonly reply: MessageEvent["reply"];
}

export interface FriendPoke {
  readonly post_type: "notice";
  readonly notice_type: "friend";
  readonly sub_type: "poke";
  readonly adapter?: "milky";
  readonly self_id: number;
  readonly user_id: number;
  readonly operator_id: number;
  readonly target_id: number;
  readonly time?: number;
  readonly [friendMessageNoticeSession]?: FriendMessageNoticeSession;
  readonly isGroup: false;
  readonly isPrivate: true;
  readonly isMaster: boolean;
  readonly reply: MessageEvent["reply"];
}

export interface GroupPoke {
  readonly post_type: "notice";
  readonly notice_type: "group";
  readonly sub_type: "poke";
  readonly adapter?: "milky";
  readonly self_id: number;
  readonly group_id: number;
  readonly user_id: number;
  readonly operator_id: number;
  readonly target_id: number;
  readonly time?: number;
  readonly isGroup: true;
  readonly isPrivate: false;
  readonly isMaster: boolean;
  readonly reply: MessageEvent["reply"];
}

export type OneBotPokeRecallNotice = (
  (Omit<FriendPoke, "sub_type" | "adapter" | typeof friendMessageNoticeSession> & { readonly peer_id: number }) |
  Omit<GroupPoke, "sub_type" | "adapter">
) & { readonly sub_type: "poke_recall"; readonly adapter: "onebot" };

interface GroupCompatibilityNoticeBase {
  readonly post_type: "notice";
  readonly self_id: number;
  readonly group_id: number;
  readonly user_id?: number;
  readonly operator_id?: number;
  readonly time?: number;
  readonly isGroup: true;
  readonly isPrivate: false;
  readonly isMaster: boolean;
  readonly reply: MessageEvent["reply"];
}

interface GroupReaction {
  readonly notice_type: "group_msg_emoji_like";
  readonly sub_type?: never;
  readonly message_id: number;
  readonly likes: readonly { readonly emoji_id: string; readonly count: number }[];
  readonly message_seq?: number | string;
  readonly is_add?: boolean;
}

interface GroupEssence {
  readonly notice_type: "group_essence";
  readonly sub_type: "add" | "delete";
  readonly message_id: number;
}

export type OneBotGroupCompatibilityNotice = GroupCompatibilityNoticeBase & { readonly adapter: "onebot" } & (
  GroupReaction | (GroupEssence & { readonly sender_id: number }) |
  { readonly notice_type: "group_card"; readonly sub_type?: never; readonly card_old?: string; readonly card_new: string } |
  { readonly notice_type: "group"; readonly sub_type: "group_name"; readonly target_id?: number; readonly name_new: string } |
  { readonly notice_type: "group"; readonly sub_type: "title"; readonly user_id: number; readonly title: string } |
  { readonly notice_type: "group"; readonly sub_type: "honor"; readonly user_id: number; readonly honor_type: string }
);

export type MilkyGroupCompatibilityNotice = GroupCompatibilityNoticeBase & { readonly adapter: "milky" } & (
  (GroupReaction & { readonly face_id: string; readonly reaction_type?: "face" | "emoji" }) |
  (GroupEssence & { readonly message_seq: number; readonly is_set: boolean }) |
  { readonly notice_type: "group_card"; readonly sub_type?: never; readonly new_group_name: string;
    readonly old_name?: string; readonly new_name?: string }
);

export interface OneBotProfileLikeNotice {
  readonly post_type: "notice";
  readonly notice_type: "friend";
  readonly sub_type: "profile_like";
  readonly adapter: "onebot";
  readonly self_id: number;
  readonly user_id: number;
  readonly operator_id: number;
  readonly operator_nick: string;
  readonly times: number;
  readonly time: number;
  readonly isGroup: false;
  readonly isPrivate: true;
  readonly isMaster: boolean;
  readonly reply: MessageEvent["reply"];
}

interface OneBotLegacySignalIdentity {
  readonly self_id: number;
  readonly user_id: number;
  readonly time: number;
  readonly reply: MessageEvent["reply"];
}

export type OneBotLegacySignal = OneBotLegacySignalIdentity & (
  { readonly post_type: "internal"; readonly notice_type: "input"; readonly sub_type: "input_status";
    readonly group_id: 0; readonly status_text: string; readonly event_type: number; readonly end: boolean; readonly message: string } |
  { readonly post_type: "system"; readonly notice_type: "offline"; readonly sub_type?: undefined;
    readonly tag: string; readonly message: string }
);

export type BotEvent = MessageEvent | GroupNotice | GroupRequest | FriendRequest | FriendPoke | GroupPoke |
  OneBotGroupCompatibilityNotice | MilkyGroupCompatibilityNotice | OneBotProfileLikeNotice | OneBotPokeRecallNotice;

export interface InboundSegment extends Readonly<Record<string, unknown>> {
  readonly type: string;
}

type MediaFile = string | Uint8Array;
type SegmentValue = string | number | boolean;

export type MessageSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "at"; readonly qq: string | number }
  | { readonly type: "face" | "reply"; readonly id: string | number }
  | { readonly type: "image"; readonly file: MediaFile; readonly summary?: string }
  | { readonly type: "record" | "video"; readonly file: MediaFile };

export interface ProtocolSegment {
  readonly type: MessageSegment["type"];
  readonly data: Readonly<Record<string, SegmentValue | Uint8Array>>;
}

type ReplyPart = string | MessageSegment | ProtocolSegment;
export type MessageReply = ReplyPart | readonly ReplyPart[];

let imagePreviews: readonly string[] = [];
const generatedImagePreviews = new WeakMap<Uint8Array, string | undefined>();

function pickImagePreview() {
  if (!imagePreviews.length) return;
  return imagePreviews[Math.floor(Math.random() * imagePreviews.length)];
}

/** 让同一份渲染结果在转发和重试时沿用首次编码的摘要。 */
export function generatedImagePreview(file: unknown, fields: Record<string, unknown>) {
  if (Object.hasOwn(fields, "summary") || !isGeneratedImage(file)) return;
  if (!generatedImagePreviews.has(file)) generatedImagePreviews.set(file, pickImagePreview());
  return generatedImagePreviews.get(file);
}

export function setImagePreviews(previews: readonly string[]) {
  imagePreviews = previews;
}

export const segment = {
  text: (text: string) => ({ type: "text", text } as const),
  at: (qq: string | number) => ({ type: "at", qq } as const),
  face: (id: string | number) => ({ type: "face", id } as const),
  reply: (id: string | number) => ({ type: "reply", id } as const),
  image(file: MediaFile, summary = pickImagePreview()) {
    return { type: "image", file, ...(summary === undefined ? {} : { summary }) } as const;
  },
  record: (file: MediaFile) => ({ type: "record", file } as const),
  video: (file: MediaFile) => ({ type: "video", file } as const),
};
