export interface MessageEvent {
  readonly msg: string;
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
  readonly onAwaitInput?: () => void;
  readonly likeSelf?: (count: number) => Promise<number>;
  readonly isFriend?: () => Promise<boolean>;
  readonly reviewGroupRequest?: (flag: string, type: GroupRequestType, approve: boolean, reason?: string) => Promise<boolean>;
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

export interface ReplyOptions {
  readonly at?: boolean | string | number;
  readonly recallMsg?: number;
}

export interface GroupNotice {
  readonly post_type: "notice";
  readonly notice_type: "group";
  readonly sub_type: "increase" | "decrease";
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
  readonly nickname?: string;
  readonly member?: { readonly card?: string; readonly nickname?: string };
  readonly dismiss?: boolean;
  readonly isGroup: true;
  readonly isPrivate: false;
  readonly isMaster: boolean;
  readonly reply: MessageEvent["reply"];
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
  readonly comment?: string;
  readonly isGroup: true;
  readonly isPrivate: false;
  readonly isMaster: boolean;
  readonly approve: (approve?: boolean, reason?: string) => Promise<boolean>;
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
  | { readonly type: "image" | "record" | "video"; readonly file: MediaFile };

export interface ProtocolSegment {
  readonly type: MessageSegment["type"];
  readonly data: Readonly<Record<string, SegmentValue | Uint8Array>>;
}

type ReplyPart = string | MessageSegment | ProtocolSegment;
export type MessageReply = ReplyPart | readonly ReplyPart[];

export const segment = {
  text: (text: string) => ({ type: "text", text } as const),
  at: (qq: string | number) => ({ type: "at", qq } as const),
  face: (id: string | number) => ({ type: "face", id } as const),
  reply: (id: string | number) => ({ type: "reply", id } as const),
  image: (file: MediaFile) => ({ type: "image", file } as const),
  record: (file: MediaFile) => ({ type: "record", file } as const),
  video: (file: MediaFile) => ({ type: "video", file } as const),
};
