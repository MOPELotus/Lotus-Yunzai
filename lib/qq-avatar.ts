import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { delegationSession } from "./command-delegation.ts";
import type { MessageEvent, MessageReply } from "./messages.ts";

interface AvatarCommand {
  readonly linkOnly: boolean;
  readonly group: boolean;
  readonly id: string;
}

export function qqAvatarCommand(text: string): AvatarCommand | undefined {
  const match = /^#?(查看|看|取)(群)?头像((?:[\s\d][\s\S]*)?)$/u.exec(text);
  if (match) return { linkOnly: match[1] === "取", group: match[2] === "群", id: match[3]?.trim() ?? "" };
}

function avatarId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

export function qqAvatarReply(event: MessageEvent, command: AvatarCommand): MessageReply | undefined {
  if (event.isDelegated || event[delegationSession]?.signal.aborted !== false ||
      (event.message_type !== "group" && (event.message_type !== "private" || event.sub_type !== "friend"))) return;
  const mention = typeof event.message === "string" ? undefined : event.message.find(part => part.type === "at")?.qq;
  const fallback = command.group ? event.group_id : event.at ?? mention ?? event.user_id;
  const id = avatarId(command.id || fallback);
  if (id === undefined) return $t("lib.qq-avatar.text_2393f69882");

  const url = command.group ? `https://p.qlogo.cn/gh/${id}/${id}/0` : `https://q.qlogo.cn/g?b=qq&s=0&nk=${id}`;
  return command.linkOnly ? url : { type: "image", file: url };
}
