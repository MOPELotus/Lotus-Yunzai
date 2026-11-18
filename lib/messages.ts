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
  readonly isGroup: boolean;
  readonly isPrivate: boolean;
  readonly isMaster: boolean;
  readonly likeSelf?: (count: number) => Promise<number>;
  readonly isFriend?: () => Promise<boolean>;
  readonly raw_message: string;
  readonly message: string | readonly InboundSegment[];
  readonly atBot?: boolean;
  readonly at?: string | number;
  readonly reply_id?: string | number;
  readonly img?: readonly string[];
  readonly reply: (message: MessageReply, quote?: boolean) => boolean;
}

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
