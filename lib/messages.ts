import type { ChatFile, ChatFileResult, IncomingChatFile } from "./chat-files.ts";
import { sendSessionMedia, type MediaDelivery, type SendSessionMedia } from "./media-delivery.ts";
import { delegationSession, type DelegationSession } from "./command-delegation.ts";
import { ownGroupCardSession, type OwnGroupCardAccount } from "./adapters/own-group-card.ts";
import type { MentionLikeTarget } from "./adapters/mention-like.ts";
import type { PendingGroupJoinBatch, PendingGroupJoinDecision, PendingGroupJoinList, QuotedJoinReviewResult } from "./group-join-review.ts";
import type { GroupActivityMember, GroupActivityVisibility, GroupAnnouncement, GroupDeleteAnnouncement, GroupKickAction, GroupManageBlacklistAction,
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
  readonly getGroupRole?: (groupId: number) => Promise<GroupMembership["botRole"] | undefined>;
  readonly setGroupCard?: (card: string, groupId?: number, userId?: number) => Promise<GroupCardResult>;
  readonly [ownGroupCardSession]?: () => OwnGroupCardAccount | undefined;
  readonly listCurrentGroupMembers?: ReadCurrentGroupMembers;
  readonly listCheckinGroupMembers?: ReadCurrentGroupMembers;
  readonly forward?: (nodes: readonly MessageReply[]) => Promise<boolean>;
  readonly uploadFile?: (file: ChatFile) => Promise<ChatFileResult>;
  readonly deliverMedia?: (file: MediaDelivery) => Promise<ChatFileResult>;
  readonly sendMusicCard?: (card: MusicCard) => Promise<ChatFileResult>;
  readonly [sendSessionMedia]?: SendSessionMedia;
  readonly attachment?: IncomingChatFile;
  readonly canReadAttachments?: boolean;
  readonly attachmentOnly?: boolean;
  readonly reviewGroupRequest?: (flag: string, type: GroupRequestType, approve: boolean, reason?: string) => Promise<boolean>;
  readonly groupRequestScope?: "milky";
  readonly canReviewGroupRequests?: boolean;
  readonly recallReply?: () => Promise<readonly RecallResult[] | undefined>;
  readonly lookupReply?: () => Promise<QuotedMessage | undefined>;
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
  readonly message: readonly InboundSegment[];
}

export type RecallResult = "confirmed" | "rejected" | "unknown";
export type GroupCardResult = RecallResult | "missing-group" | "insufficient-role";

export interface ReplyOptions {
  readonly at?: boolean | string | number;
  readonly recallMsg?: number;
  readonly onDelivered?: (messageId: number) => void | Promise<void>;
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
  readonly inspectAutoQuit?: (maxMembers: number) => Promise<GroupMembership | undefined>;
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
  readonly reply: MessageEvent["reply"];
}

export interface FriendRequest {
  readonly post_type: "request";
  readonly request_type: "friend";
  readonly sub_type: "add";
  readonly self_id: number;
  readonly user_id: number;
  readonly flag: string;
  readonly comment?: string;
  readonly isGroup: false;
  readonly isPrivate: true;
  readonly isMaster: boolean;
  readonly approve: (approve?: boolean, remark?: string) => Promise<boolean>;
  readonly notifyMasters: (message: string) => Promise<number>;
  readonly reply: MessageEvent["reply"];
}

export interface FriendPoke {
  readonly post_type: "notice";
  readonly notice_type: "friend";
  readonly sub_type: "poke";
  readonly self_id: number;
  readonly user_id: number;
  readonly operator_id: number;
  readonly target_id: number;
  readonly isGroup: false;
  readonly isPrivate: true;
  readonly isMaster: boolean;
  readonly reply: MessageEvent["reply"];
}

export type BotEvent = MessageEvent | GroupNotice | GroupRequest | FriendRequest | FriendPoke;

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

export function setImagePreviews(previews: readonly string[]) {
  imagePreviews = previews;
}

export const segment = {
  text: (text: string) => ({ type: "text", text } as const),
  at: (qq: string | number) => ({ type: "at", qq } as const),
  face: (id: string | number) => ({ type: "face", id } as const),
  reply: (id: string | number) => ({ type: "reply", id } as const),
  image(file: MediaFile, summary = imagePreviews.length ? imagePreviews[Math.floor(Math.random() * imagePreviews.length)] : undefined) {
    return { type: "image", file, ...(summary === undefined ? {} : { summary }) } as const;
  },
  record: (file: MediaFile) => ({ type: "record", file } as const),
  video: (file: MediaFile) => ({ type: "video", file } as const),
};
