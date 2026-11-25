import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { ownerAccountGender, ownerAccountSession, ownerAccountStatus, type OwnerAccountOperation } from "./adapters/owner-account.ts";
import type { MessageEvent } from "./messages.ts";

export const ownerAccountFeatureNames = ["[group] 机器人账号资料", "group", "@lotus-yunzai/group"];
const pattern = /^#((?:改|换)(?:昵|名)称?|改签名|改状态|改性别|删好友|设置机型)([\s\S]*)$/u;
const maxHistory = 4096;

function positiveId(raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return;
  const id = Number(raw);
  if (/^[1-9]\d*$/u.test(String(raw)) && Number.isSafeInteger(id)) return id;
}

function friendId(event: MessageEvent, text: string) {
  const mentions = typeof event.message === "string" ? [] : event.message.filter(part => part.type === "at");
  const fromText = positiveId(text);
  if (mentions.length === 0) return fromText;
  if (mentions.length !== 1 || (text && !fromText)) return;
  const mention = positiveId(mentions[0]?.qq);
  if (fromText === undefined || fromText === mention) return mention;
}

export function createOwnerAccountCommand() {
  const history = new Set<string>();
  return async (event: MessageEvent, workflow: AbortSignal, allowed: () => boolean) => {
    const match = pattern.exec(event.msg);
    if (!match || event.isDelegated) return false;
    const session = event[ownerAccountSession];
    if (!session || !session.isOwner()) {
      await event.reply($t("lib.owner-account-command.text_2376d77177"));
      return true;
    }
    if (session.signal.aborted || workflow.aborted || !allowed()) return true;
    if (match[1] === "设置机型") {
      await event.reply($t("lib.owner-account-command.text_eda200f345"));
      return true;
    }

    const text = match[2]!.trim();
    let operation: OwnerAccountOperation;
    let label: string;
    if (match[1] === "删好友") {
      const userId = friendId(event, text);
      if (userId === undefined || userId === event.self_id) {
        await event.reply($t("lib.owner-account-command.text_b981d1f93a"));
        return true;
      }
      operation = { kind: "deleteFriend", userId };
      label = $t("lib.owner-account-command.text_3cb3cff22b");
    } else if (match[1] === "改状态") {
      if (!Object.hasOwn(ownerAccountStatus, text)) {
        await event.reply($t("lib.owner-account-command.text_d7b8ee3526", { "value1": Object.keys(ownerAccountStatus).join("、") }));
        return true;
      }
      operation = { kind: "status", status: ownerAccountStatus[text as keyof typeof ownerAccountStatus] };
      label = $t("lib.owner-account-command.text_c15720c414");
    } else if (match[1] === "改性别") {
      if (!Object.hasOwn(ownerAccountGender, text)) {
        await event.reply($t("lib.owner-account-command.text_f5b413f2f2"));
        return true;
      }
      operation = { kind: "gender", gender: ownerAccountGender[text as keyof typeof ownerAccountGender] };
      label = $t("lib.owner-account-command.text_66eb1c77a2");
    } else {
      const signature = match[1] === "改签名";
      label = signature ? $t("lib.owner-account-command.text_37968cced8") : $t("lib.owner-account-command.text_8634d262cf");
      if ((!signature && !text) || Buffer.byteLength(text) > 512 || /[\u0000-\u001f\u007f]/u.test(text)) {
        await event.reply(signature ? $t("lib.owner-account-command.text_4f264a272a") : $t("lib.owner-account-command.text_f17d584dba"));
        return true;
      }
      operation = { kind: signature ? "signature" : "nickname", text };
    }
    // Protocol retransmission of the same inbound message must not repeat an account write.
    const key = JSON.stringify([event.adapter ?? "onebot", event.self_id, event.message_type,
      event.group_id ?? event.user_id, event.message_id]);
    if (event.message_id === undefined || history.has(key)) return true;
    if (history.size >= maxHistory) history.delete(history.values().next().value!);
    history.add(key);
    const outcome = await session.perform(operation, workflow, allowed);
    if (session.signal.aborted || workflow.aborted || !session.isOwner() || !allowed()) return true;
    const reply = outcome === "confirmed" ? $t("lib.owner-account-command.text_699c0487e3", { "label": label })
      : outcome === "notFriend" ? $t("lib.owner-account-command.text_da8a2d6174")
      : outcome === "unsupported" ? $t("lib.owner-account-command.text_c4e2cbb46d", { "label": label })
      : outcome === "unavailable" ? $t("lib.owner-account-command.text_64cbde6a0f")
      : outcome === "unknown" ? $t("lib.owner-account-command.text_0888f34a60", { "label": label }) : $t("lib.owner-account-command.text_262854e58d", { "label": label });
    await event.reply(reply);
    return true;
  };
}
