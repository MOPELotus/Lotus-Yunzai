import type { MessageEvent } from "./messages.ts";

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isMilkyPackageManager(event: MessageEvent): boolean {
  return event.adapter === "milky" && event.canManageProcess === true && positiveId(event.self_id) &&
    positiveId(event.user_id) && (event.message_type === "private" ||
      (event.message_type === "group" && positiveId(event.group_id)));
}

export function canManagePackages(event: MessageEvent): boolean {
  if (event.adapter === "milky") return isMilkyPackageManager(event);
  return event.isMaster === true && (event.message_type === "terminal" || event.boundAccount === true);
}
