import { setTimeout as wait } from "node:timers/promises";
import type { ChatFileResult } from "./chat-files.ts";
import type { MessageEvent } from "./messages.ts";

export const manualGroupLeaveSession = Symbol("manualGroupLeaveSession");

export interface ManualGroupLeaveSession {
  readonly botId: number;
  readonly userId: number;
  readonly groupId?: number;
  readonly signal: AbortSignal;
  isMaster(): boolean;
  groups(signal: AbortSignal): Promise<readonly { readonly id: number }[]>;
  leave(groupId: number, signal: AbortSignal): Promise<ChatFileResult>;
  reply(text: string, signal: AbortSignal): Promise<ChatFileResult>;
}

export function manualGroupLeaveInput(msg: string) {
  return /^#退群(?![^\s0-9])([\s\S]*)$/u.exec(msg)?.[1]?.trim();
}

export function createManualGroupLeave(
  pause: (signal: AbortSignal) => Promise<unknown> = signal => wait(3_000, undefined, { signal, ref: false }),
) {
  const pending = new Set<string>();

  return async (event: MessageEvent, input: string, allowed: () => boolean, workflow: AbortSignal) => {
    const session = event[manualGroupLeaveSession];
    if (event.isDelegated || !session || session.botId !== event.self_id || session.userId !== event.user_id ||
        session.groupId !== event.group_id ||
        (event.message_type !== "group" && (event.message_type !== "private" || event.sub_type !== "friend"))) return;
    const signal = AbortSignal.any([session.signal, workflow]);
    const active = () => !signal.aborted && allowed();
    if (!active()) return;
    if (!session.isMaster()) {
      await session.reply("❎ 该命令仅限主人可用", signal);
      return;
    }

    const authorized = () => active() && session.isMaster();
    const reply = async (text: string) => {
      if (authorized()) await session.reply(text, signal);
    };
    if (!input) return reply("❎ 群号不能为空");
    const groupId = Number(input);
    if (!/^\d+$/u.test(input) || !Number.isSafeInteger(groupId) || groupId < 1) {
      return reply("❎ 群号不合法");
    }

    const key = `${session.botId}:${groupId}`;
    if (pending.has(key)) return reply("该群的退群操作正在处理。");
    pending.add(key);
    try {
      const verify = async () => {
        if (!authorized()) return false;
        const groups = await session.groups(signal).catch(() => undefined);
        if (!authorized()) return false;
        if (!groups) {
          await reply("❎ 无法确认当前账号的群列表");
          return false;
        }
        if (groups.some(group => group.id === groupId)) return true;
        await reply("❎ 群聊列表查无此群");
        return false;
      };

      if (!await verify() || !authorized()) return;
      if (session.groupId === groupId) {
        const warning = await session.reply("⚠️ 3秒后退出本群聊", signal);
        if (!authorized()) return;
        if (warning !== "confirmed") {
          await reply("未确认退群提醒，本次未退出。可在好友私聊中再操作。");
          return;
        }
        try { await pause(signal); } catch { return; }
        if (!await verify() || !authorized()) return;
      }

      const outcome = await session.leave(groupId, signal).catch(() => "unknown");
      await reply(outcome === "confirmed" ? "✅ 已退出群聊" :
        outcome === "rejected" ? "❎ 退出失败" : "退群结果未确认，请先在 QQ 核对。");
    } finally {
      pending.delete(key);
    }
  };
}
