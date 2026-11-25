import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
      await session.reply($t("lib.manual-group-leave.text_d46f6afc9a"), signal);
      return;
    }

    const authorized = () => active() && session.isMaster();
    const reply = async (text: string) => {
      if (authorized()) await session.reply(text, signal);
    };
    if (!input) return reply($t("lib.manual-group-leave.text_05551f1fa4"));
    const groupId = Number(input);
    if (!/^\d+$/u.test(input) || !Number.isSafeInteger(groupId) || groupId < 1) {
      return reply($t("lib.manual-group-leave.text_2fb35621ad"));
    }

    const key = `${session.botId}:${groupId}`;
    if (pending.has(key)) return reply($t("lib.manual-group-leave.text_3e7cd2b751"));
    pending.add(key);
    try {
      const verify = async () => {
        if (!authorized()) return false;
        const groups = await session.groups(signal).catch(() => undefined);
        if (!authorized()) return false;
        if (!groups) {
          await reply($t("lib.manual-group-leave.text_3ad8b214f0"));
          return false;
        }
        if (groups.some(group => group.id === groupId)) return true;
        await reply($t("lib.manual-group-leave.text_d76007fb01"));
        return false;
      };

      if (!await verify() || !authorized()) return;
      if (session.groupId === groupId) {
        const warning = await session.reply($t("lib.manual-group-leave.text_5cf0a0bf93"), signal);
        if (!authorized()) return;
        if (warning !== "confirmed") {
          await reply($t("lib.manual-group-leave.text_c352b84603"));
          return;
        }
        try { await pause(signal); } catch { return; }
        if (!await verify() || !authorized()) return;
      }

      const outcome = await session.leave(groupId, signal).catch(() => "unknown");
      await reply(outcome === "confirmed" ? $t("lib.manual-group-leave.text_449f91345a") :
        outcome === "rejected" ? $t("lib.manual-group-leave.text_781b5335ae") : $t("lib.manual-group-leave.text_f997815527"));
    } finally {
      pending.delete(key);
    }
  };
}
