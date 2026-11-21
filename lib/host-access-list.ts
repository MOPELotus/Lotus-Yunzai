import type { HostAccessList } from "./master-config.ts";
import type { MessageEvent } from "./messages.ts";

const command = /^#(取消|删除|移除)?拉(黑|白)(群聊?)?\s*(.*)$/u;
export const hostAccessListNames = ["拉黑白名单", "system", "@lotus-yunzai/system"] as const;

function positiveId(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
}

export function hostAccessListCommand(event: Pick<MessageEvent, "msg" | "message" | "message_type" | "self_id" | "group_id">) {
  const match = command.exec(event.msg);
  if (!match) return;
  const [, removal, color, group, raw = ""] = match;
  const text = raw.trim();
  const remove = removal !== undefined;
  const key: HostAccessList = group ? color === "黑" ? "blackGroup" : "whiteGroup" : color === "黑" ? "blackUser" : "whiteUser";
  const label = `${remove ? "取消" : ""}拉${color}${group ? "群" : ""}`;
  const parts = typeof event.message === "string" ? [] : event.message;
  const hasForeignPart = parts.some(part => part.type !== "text" && part.type !== "at");
  const mentions = parts.filter(part => part.type === "at" && positiveId(part.qq) !== event.self_id);
  const currentGroup = !!group && !text && !mentions.length && event.message_type === "group";
  const target = hasForeignPart ? undefined
    : mentions.length ? !group && !text && mentions.length === 1 && event.message_type === "group" ? positiveId(mentions[0]?.qq) : undefined
    : currentGroup ? positiveId(event.group_id) : positiveId(text);
  return { key, label, remove, target, currentGroup };
}
