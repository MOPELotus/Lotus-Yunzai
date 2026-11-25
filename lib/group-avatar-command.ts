import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { groupAvatarSession, maxGroupAvatarBytes } from "./adapters/group-avatar.ts";
import { ownerAccountSession } from "./adapters/owner-account.ts";
import { readQqMessageImage } from "./chat-files.ts";
import { delegationSession } from "./command-delegation.ts";
import { isVerifiedRaster } from "./file-to-url.ts";
import type { MessageEvent } from "./messages.ts";

export const groupAvatarNames = [$t("lib.group-avatar-command.text_d50f952d13"), "group", "@lotus-yunzai/group"];
const command = /^#(?:改|换)(群)?头像([\s\S]*)$/u;
const groupCancel = /^(?:取消|#取消(?:改|换)群头像)$/u;
const accountCancel = /^(?:取消|#取消(?:改|换)头像)$/u;
const waitingMs = 120_000;
const maxWaiting = 128;
const maxProcessed = 4096;
export type AvatarKind = "group" | "account";

interface Waiting {
  readonly kind: AvatarKind;
  readonly group: number | undefined;
  readonly signal: AbortSignal;
}

function firstImage(message?: MessageEvent["message"]) {
  return Array.isArray(message) ? message.find(part => part.type === "image") : undefined;
}

export function createGroupAvatarCommand() {
  const pending = new WeakMap<AbortSignal, Map<string, Waiting>>();
  const processedAccounts = new Set<string>();
  return async (event: MessageEvent, options: {
    readonly allowNew: boolean;
    workflow(): AbortSignal;
    allowed(kind: AvatarKind): boolean;
    permitted(kind: AvatarKind): boolean | Promise<boolean>;
  }): Promise<boolean> => {
    const input = event.msg.trim();
    const match = command.exec(input);
    const connection = event[delegationSession]?.signal;
    const matchKind = match ? (match[1] ? "group" : "account") : undefined;
    if (matchKind !== undefined && !options.allowed(matchKind)) return false;
    if (event.isDelegated || event.attachmentOnly || !connection || connection.aborted || event.self_id === undefined ||
        event.user_id === undefined || (event.isGroup ? event.group_id === undefined : event.sub_type !== "friend")) return !!match;
    const key = `${event.self_id}:${event.group_id ?? "private"}:${event.user_id}`;
    const current = pending.get(connection);
    const previous = current?.get(key);
    if (previous?.signal.aborted) current?.delete(key);
    const waiting = previous?.signal.aborted === false ? previous : undefined;
    const kind = matchKind ?? waiting?.kind;
    if (!kind || !options.allowed(kind)) return false;
    const cancel = kind === "group" ? groupCancel : accountCancel;
    if (!match && (!waiting || (/^[#/*%]/u.test(input) && !cancel.test(input)))) return false;
    if (match && !options.allowNew) return true;
    const waits = current ?? new Map<string, Waiting>();

    const groupAccess = event[groupAvatarSession];
    const accountAccess = event[ownerAccountSession];
    const access = kind === "group" ? groupAccess : accountAccess;
    if (!access || (kind === "account" && !accountAccess?.isOwner())) {
      if (match && kind === "account") await event.reply($t("lib.group-avatar-command.text_965f1431b6"));
      return !!match || !!waiting;
    }
    const signal = AbortSignal.any([access.signal, connection, options.workflow(), ...(!match && waiting ? [waiting.signal] : [])]);
    const allowed = () => !signal.aborted && options.allowed(kind) && (kind === "group" || accountAccess?.isOwner() === true);
    const active = async () => allowed() && await options.permitted(kind) && allowed();
    const reply = async (text: string) => { if (await active()) await event.reply(text); };
    if (!await active()) return true;
    if (!match && cancel.test(input)) {
      if (waits.get(key) !== waiting) return true;
      waits.delete(key);
      await reply($t("lib.group-avatar-command.text_da1a384ab2"));
      return true;
    }
    let group = waiting?.group;
    if (match) {
      waits.delete(key);
      const target = match[2]!.trim();
      group = undefined;
      if (kind === "account") {
        if (target) {
          await reply($t("lib.group-avatar-command.text_e072c6e620"));
          return true;
        }
      } else if (event.isGroup) {
        if (target) {
          await reply($t("lib.group-avatar-command.text_f009f9087c"));
          return true;
        }
      } else {
        group = Number(target);
        if (!/^[1-9]\d*$/u.test(target) || !Number.isSafeInteger(group)) {
          await reply($t("lib.group-avatar-command.text_c7e5c6dd70"));
          return true;
        }
      }
    }

    if (!match && !firstImage(event.message)) {
      if (input) await reply($t("lib.group-avatar-command.text_ada0140652"));
      return true;
    }
    if (!match) {
      if (waits.get(key) !== waiting) return true;
      waits.delete(key);
    }
    const available = kind === "group" ? await groupAccess!.prepare(group, signal) : await accountAccess!.prepareAvatar(signal, allowed);
    if (available !== "ready") {
      const subject = kind === "group" ? $t("lib.group-avatar-command.text_9352fee677") : $t("lib.group-avatar-command.text_305b21d203");
      await reply(available === "unsupported" ? $t("lib.group-avatar-command.text_1c878ff74d", { "subject": subject }) : kind === "group"
        ? $t("lib.group-avatar-command.text_e663acc8ef") : $t("lib.group-avatar-command.text_2ea469f7b5"));
      return true;
    }

    const transfer = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let image = firstImage(event.message);
    if (match && event.reply_id !== undefined) {
      const quote = await event.lookupMediaReply?.(transfer).catch(() => undefined);
      if (!quote) {
        await reply($t("lib.group-avatar-command.text_8058081a1b"));
        return true;
      }
      image = firstImage(quote.message) ?? image;
    }
    if (!await active()) return true;
    if (!image) {
      for (const [id, entry] of waits) if (entry.signal.aborted) waits.delete(id);
      if (waits.size >= maxWaiting) {
        await reply($t("lib.group-avatar-command.text_e71e946486"));
        return true;
      }
      waits.set(key, { kind, group, signal: AbortSignal.any([signal, AbortSignal.timeout(waitingMs)]) });
      pending.set(connection, waits);
      await reply($t("lib.group-avatar-command.text_80abaf62a3"));
      return true;
    }
    const bytes = await readQqMessageImage(image, transfer, { maxBytes: maxGroupAvatarBytes, fallback: image.file }).catch(() => undefined);
    if (!bytes || !await isVerifiedRaster(bytes, 16_000_000, 4096)) {
      await reply($t("lib.group-avatar-command.text_badbde8d77"));
      return true;
    }
    if (!await active()) return true;
    if (kind === "account") {
      if (event.message_id === undefined) return true;
      const messageKey = JSON.stringify([event.adapter ?? "onebot", key, event.message_id]);
      if (processedAccounts.has(messageKey)) return true;
      if (processedAccounts.size >= maxProcessed) processedAccounts.delete(processedAccounts.values().next().value!);
      processedAccounts.add(messageKey);
      const result = await accountAccess!.perform({ kind: "avatar", bytes }, signal, allowed);
      switch (result) {
        case "confirmed": await reply($t("lib.group-avatar-command.text_afb2392f4d")); break;
        case "rejected": await reply($t("lib.group-avatar-command.text_28d9f27d05")); break;
        case "unsupported": await reply($t("lib.group-avatar-command.text_5669c568aa")); break;
        case "unknown": await reply($t("lib.group-avatar-command.text_047814e808")); break;
        default: await reply($t("lib.group-avatar-command.text_2ea469f7b5"));
      }
      return true;
    }
    const result = await groupAccess!.apply(group, bytes, signal);
    switch (result) {
      case "confirmed": await reply($t("lib.group-avatar-command.text_7c620ababa")); break;
      case "rejected": await reply($t("lib.group-avatar-command.text_5998d9fd00")); break;
      case "unavailable": await reply($t("lib.group-avatar-command.text_e663acc8ef")); break;
      case "unknown": await reply($t("lib.group-avatar-command.text_130e82c810")); break;
    }
    return true;
  };
}
