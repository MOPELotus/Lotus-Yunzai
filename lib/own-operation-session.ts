/** A current, original sender session for operations on that sender's own account. */
export interface OwnOperationContext {
  readonly message_type?: string;
  readonly sub_type?: string;
  readonly user_id?: number;
  readonly self_id?: number;
  readonly group_id?: number;
  readonly message_id?: string | number;
  readonly adapter?: string;
  readonly sender?: { readonly user_id?: number | string };
  readonly isDelegated?: boolean;
  readonly privateCredentialSignal?: AbortSignal;
  readonly groupActivitySignal?: AbortSignal;
}
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export function ownOperationSession(context: OwnOperationContext) {
  const { user_id: user, self_id: bot, group_id: group, sender } = context;
  if (context.isDelegated || !positive(user) || !positive(bot) || user === bot ||
      (sender?.user_id !== undefined && String(sender.user_id) !== String(user))) return;
  const inGroup = context.message_type === "group";
  if (inGroup ? !positive(group) || context.sub_type === "anonymous" || context.message_id === undefined
    : context.message_type !== "private" || group !== undefined || (context.sub_type !== undefined && context.sub_type !== "friend")) return;
  const signal = inGroup ? context.groupActivitySignal : context.privateCredentialSignal;
  if (!signal || signal.aborted) return;
  return { user, bot, signal, group: inGroup ? group : undefined,
    scope: `${context.adapter ?? "onebot"}:${bot}:${inGroup ? `group:${group}:` : ""}${user}` };
}
