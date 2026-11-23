import { groupAvatarSession, maxGroupAvatarBytes } from "./adapters/group-avatar.ts";
import { ownerAccountSession } from "./adapters/owner-account.ts";
import { readQqMessageImage } from "./chat-files.ts";
import { delegationSession } from "./command-delegation.ts";
import { isVerifiedRaster } from "./file-to-url.ts";
import type { MessageEvent } from "./messages.ts";

export const groupAvatarNames = ["[group] 修改群头像", "group", "@lotus-yunzai/group"];
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
      if (match && kind === "account") await event.reply("只有当前机器人的主人可在群聊或好友私聊修改头像。");
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
      await reply("✅ 已取消");
      return true;
    }
    let group = waiting?.group;
    if (match) {
      waits.delete(key);
      const target = match[2]!.trim();
      group = undefined;
      if (kind === "account") {
        if (target) {
          await reply("请发送或引用要设为机器人头像的图片。");
          return true;
        }
      } else if (event.isGroup) {
        if (target) {
          await reply("请发送或引用图片。群聊中只能修改当前群头像。");
          return true;
        }
      } else {
        group = Number(target);
        if (!/^[1-9]\d*$/u.test(target) || !Number.isSafeInteger(group)) {
          await reply("请指定有效群号，并发送或引用图片。");
          return true;
        }
      }
    }

    if (!match && !firstImage(event.message)) {
      if (input) await reply("⚠ 请发送图片或取消");
      return true;
    }
    if (!match) {
      if (waits.get(key) !== waiting) return true;
      waits.delete(key);
    }
    const available = kind === "group" ? await groupAccess!.prepare(group, signal) : await accountAccess!.prepareAvatar(signal, allowed);
    if (available !== "ready") {
      const subject = kind === "group" ? "群头像" : "机器人头像";
      await reply(available === "unsupported" ? `当前协议端未确认支持修改${subject}。` : kind === "group"
        ? "当前账号或操作者没有修改该群头像的权限。" : "无法确认当前会话的主人权限或好友关系。");
      return true;
    }

    const transfer = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let image = firstImage(event.message);
    if (match && event.reply_id !== undefined) {
      const quote = await event.lookupMediaReply?.(transfer).catch(() => undefined);
      if (!quote) {
        await reply("无法读取当前会话的引用消息。");
        return true;
      }
      image = firstImage(quote.message) ?? image;
    }
    if (!await active()) return true;
    if (!image) {
      for (const [id, entry] of waits) if (entry.signal.aborted) waits.delete(id);
      if (waits.size >= maxWaiting) {
        await reply("当前等待图片的请求过多，请稍后重试。");
        return true;
      }
      waits.set(key, { kind, group, signal: AbortSignal.any([signal, AbortSignal.timeout(waitingMs)]) });
      pending.set(connection, waits);
      await reply("⚠ 请发送图片");
      return true;
    }
    const bytes = await readQqMessageImage(image, transfer, { maxBytes: maxGroupAvatarBytes, fallback: image.file }).catch(() => undefined);
    if (!bytes || !await isVerifiedRaster(bytes, 16_000_000, 4096)) {
      await reply("无法读取这张图片，或图片尺寸过大。请重新发送命令。");
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
        case "confirmed": await reply("✅ 头像修改成功"); break;
        case "rejected": await reply("❎ 头像修改失败"); break;
        case "unsupported": await reply("当前协议端未确认支持修改机器人头像。"); break;
        case "unknown": await reply("头像修改结果未确认，请在 QQ 中核对。"); break;
        default: await reply("无法确认当前会话的主人权限或好友关系。");
      }
      return true;
    }
    const result = await groupAccess!.apply(group, bytes, signal);
    switch (result) {
      case "confirmed": await reply("✅ 群头像修改成功"); break;
      case "rejected": await reply("❎ 群头像修改失败"); break;
      case "unavailable": await reply("当前账号或操作者没有修改该群头像的权限。"); break;
      case "unknown": await reply("群头像修改结果未确认，请先查看群信息。"); break;
    }
    return true;
  };
}
