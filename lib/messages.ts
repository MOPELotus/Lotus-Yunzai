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
  readonly raw_message: string;
  readonly message: string | readonly unknown[];
  readonly reply: (text: string, quote?: boolean) => boolean;
}
