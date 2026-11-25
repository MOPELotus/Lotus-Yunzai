import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { ChatFileResult } from "./chat-files.ts";
import type { MessageEvent, MessageReply } from "./messages.ts";
import { memberDisplayName } from "./adapters/onebot-member-display.ts";

type ContactKind = "群" | "好友";
interface ContactListCommand {
  readonly kind: ContactKind;
  readonly argument: string;
}

interface Contact {
  readonly id: number;
  readonly name?: string;
}

export const ownerContactListSession = Symbol("ownerContactListSession");
export interface OwnerContactListSession {
  readonly botId: number;
  readonly ownerId: number;
  readonly signal: AbortSignal;
  authorized(): boolean;
  groups(signal: AbortSignal): Promise<readonly Contact[] | undefined>;
  friends(signal: AbortSignal): Promise<readonly unknown[] | undefined>;
  forward(nodes: readonly MessageReply[], signal: AbortSignal): Promise<ChatFileResult>;
  reply(text: string, signal: AbortSignal): Promise<ChatFileResult>;
}

const commandPattern = /^#(?:获取)?(群|好友)列表(?:\s+([\s\S]*))?$/u;
const pageSize = 40;
const nodeSize = 10;

export function ownerContactListCommand(msg: string): ContactListCommand | undefined {
  const match = commandPattern.exec(msg);
  if (!match) return;
  const kind = match[1];
  if (kind === "群" || kind === "好友") return { kind, argument: match[2]?.trim() ?? "" };
}

function gatewayId(value: unknown) {
  return typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value) ? Number(value) : value;
}

export function parseFriendList(items: readonly unknown[] | undefined): readonly Contact[] | undefined {
  if (!items) return;
  const entries: Contact[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || !("user_id" in item)) return;
    const id = gatewayId(item.user_id);
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return;
    entries.push({ id, name: "nickname" in item ? memberDisplayName(item.nickname) : undefined });
  }
  return entries;
}

export async function replyOwnerContactList(
  event: MessageEvent, { kind, argument }: ContactListCommand, snapshots?: {
    displayedGroups(event: MessageEvent): readonly Contact[] | undefined;
    rememberGroups(event: MessageEvent, groups: readonly Contact[]): void;
  },
) {
  const session = event[ownerContactListSession];
  if (event.isDelegated || event.message_type !== "private" || event.sub_type !== "friend" ||
      !session || session.botId !== event.self_id || session.ownerId !== event.user_id) return;

  const { signal } = session;
  const authorized = () => !signal.aborted && session.authorized();
  if (!authorized()) return;
  const title = $t("lib.owner-contact-list.text_b7bfc0a2e9", { "kind": kind });
  const reply = async (text: string) => {
    if (authorized()) await session.reply(text, signal);
  };
  const page = argument ? Number(argument) : 1;
  if (argument && (!/^[1-9]\d{0,5}$/u.test(argument) || !Number.isSafeInteger(page))) {
    await reply($t("lib.owner-contact-list.text_09fc6c8650", { "title": title }));
    return;
  }
  const shown = kind === "群" && page > 1 ? snapshots?.displayedGroups(event) : undefined;
  const loaded = kind === "群" ? shown ?? await session.groups(signal).catch(() => undefined)
    : parseFriendList(await session.friends(signal).catch(() => undefined));
  if (!authorized()) return;
  if (!loaded) {
    await reply($t("lib.owner-contact-list.text_b5e5af79ee", { "title": title }));
    return;
  }
  if (!loaded.length) {
    await reply($t("lib.owner-contact-list.text_414085dba6", { "kind": kind }));
    return;
  }

  const pages = Math.ceil(loaded.length / pageSize);
  if (page > pages) {
    await reply($t("lib.owner-contact-list.text_49a6a53663", { "title": title, "pages": pages, "value3": pages }));
    return;
  }
  const start = (page - 1) * pageSize;
  const rows = loaded.slice(start, start + pageSize).map(({ id, name }, index) => {
    const label = memberDisplayName(name)?.replace(/[\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, 80);
    return `${start + index + 1}、${label || $t("lib.owner-contact-list.text_2e72569d34")}(${id})`;
  });
  const nodes = [$t("lib.owner-contact-list.text_747c03e05d", { "title": title, "length": loaded.length, "page": page, "pages": pages, "value5": page < pages ? $t("lib.owner-contact-list.text_bbda6f77b3", { "title": title, "value2": page + 1 }) : "" })];
  for (let offset = 0; offset < rows.length; offset += nodeSize) {
    nodes.push(rows.slice(offset, offset + nodeSize).join("\n"));
  }
  if (!authorized()) return;
  const result = await session.forward(nodes, signal).catch(() => "unknown");
  if (result === "confirmed" && kind === "群" && !shown && authorized()) snapshots?.rememberGroups(event, loaded);
  if (result === "rejected") await reply($t("lib.owner-contact-list.text_784ef1130f", { "title": title }));
  if (result === "unknown") await reply($t("lib.owner-contact-list.text_aefc6c6077", { "title": title }));
}
