import { ownerAccountSession, ownerAccountStatus, type OwnerAccountOperation } from "./adapters/owner-account.ts";
import type { MessageEvent } from "./messages.ts";

export const ownerAccountFeatureNames = ["[group] 机器人账号资料", "group", "@lotus-yunzai/group"];
const pattern = /^#((?:改|换)(?:昵|名)称?|改签名|改状态|删好友)([\s\S]*)$/u;
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
      await event.reply("只有当前机器人的主人可在群聊或好友私聊使用此功能。");
      return true;
    }
    if (session.signal.aborted || workflow.aborted || !allowed()) return true;

    const text = match[2]!.trim();
    let operation: OwnerAccountOperation;
    let label: string;
    if (match[1] === "删好友") {
      const userId = friendId(event, text);
      if (userId === undefined || userId === event.self_id) {
        await event.reply("请指定一个有效的好友 QQ 号或只提及一位好友。");
        return true;
      }
      operation = { kind: "deleteFriend", userId };
      label = "删除好友";
    } else if (match[1] === "改状态") {
      if (!Object.hasOwn(ownerAccountStatus, text)) {
        await event.reply(`可选在线状态为${Object.keys(ownerAccountStatus).join("、")}。`);
        return true;
      }
      operation = { kind: "status", status: ownerAccountStatus[text as keyof typeof ownerAccountStatus] };
      label = "修改在线状态";
    } else {
      const signature = match[1] === "改签名";
      label = signature ? "修改签名" : "修改昵称";
      if ((!signature && !text) || Buffer.byteLength(text) > 512 || /[\u0000-\u001f\u007f]/u.test(text)) {
        await event.reply(signature ? "签名格式无效。" : "请输入有效昵称。");
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
    const reply = outcome === "confirmed" ? `${label}成功。`
      : outcome === "notFriend" ? "当前机器人的好友列表中没有这个 QQ 号。"
      : outcome === "unsupported" ? `当前协议端未确认支持${label}。`
      : outcome === "unavailable" ? "无法确认当前会话的权限或好友关系。"
      : outcome === "unknown" ? `${label}结果未确认，请在 QQ 中核对。` : `${label}失败。`;
    await event.reply(reply);
    return true;
  };
}
