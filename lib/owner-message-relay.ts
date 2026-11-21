import { setTimeout as delay } from "node:timers/promises";
import { delegationSession } from "./command-delegation.ts";
import { readFriendReplyParts, type OwnerFriendReplyBody } from "./adapters/owner-friend-reply.ts";
import type { CheckinNotifyDelivery } from "./checkin-notify.ts";
import type { MessageEvent, MessageReply } from "./messages.ts";
import type { createRequestClaim } from "./request-claim.ts";

type Group = { readonly id: number; readonly name?: string };
type Adapter = "onebot" | "milky";
type Kind = "friend" | "group";
type Command = { readonly kind: Kind; readonly botId?: number; readonly target: number; readonly text: string } |
  { readonly kind: "list"; readonly indexes: readonly number[]; readonly text: string };

export interface OwnerRelayAccount {
  readonly botId: number;
  readonly adapter: Adapter;
  friendship(id: number): Promise<boolean | undefined>;
  groups(signal: AbortSignal): Promise<readonly Group[]>;
  send(kind: Kind, id: number, body: MessageReply): Promise<CheckinNotifyDelivery>;
}

interface Scope {
  readonly signal: AbortSignal;
  readonly allowNew: boolean;
  allowed(): boolean;
}

interface Draft {
  readonly account: OwnerRelayAccount;
  readonly kind: Kind;
  readonly id: number;
  readonly source: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
}

const direct = /^#(\d*)\s?(发好友|发群聊)\s?(\d+)\s?([\s\S]*)$/u;
const numbered = /^#发群列表\s?(\d+(?:,\d+)*)(\s?)([\s\S]*)$/u;
const prefix = /^#(?:\d*\s?(?:发好友|发群聊)|发群列表)/u;
const lifetime = 120_000;
const snapshotLifetime = 300_000;
const maximumSnapshots = 128;
export const ownerRelayFeatureNames = ["[group] 消息代发", "group", "@lotus-yunzai/group"] as const;

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function ownerRelayCommand(message: string): Command | undefined {
  const target = direct.exec(message);
  if (target) return {
    kind: target[2] === "发好友" ? "friend" : "group",
    botId: target[1] ? Number(target[1]) : undefined, target: Number(target[3]), text: target[4] ?? "",
  };
  const list = numbered.exec(message);
  if (list && (list[2] || !/^[,，]/u.test(list[3] ?? ""))) {
    return { kind: "list", indexes: list[1]!.split(",").map(Number), text: list[3] ?? "" };
  }
}

function idOf(event: MessageEvent) {
  const source = event[delegationSession]?.signal;
  const { self_id: botId, user_id: actorId, message_id: messageId, group_id: groupId, sender } = event;
  const adapter: Adapter = event.adapter ?? "onebot";
  const group = event.message_type === "group" && positive(groupId) && event.sub_type !== "anonymous";
  const friend = event.message_type === "private" && event.sub_type === "friend" && groupId === undefined;
  if (!source || source.aborted || event.isDelegated || event.attachmentOnly ||
      (!group && !friend) || !positive(botId) || !positive(actorId) || !Number.isSafeInteger(messageId) ||
      (sender?.user_id !== undefined && sender.user_id !== actorId && sender.user_id !== String(actorId))) return;
  return { botId, actorId, adapter, source, messageId, groupId };
}

function messageParts(event: MessageEvent, text: string | undefined): OwnerFriendReplyBody | undefined {
  if (typeof event.message === "string") return text ?? event.message;
  const decoded = event.message.map(part => part.type === "text" && typeof part.text === "string" ? part.text : "");
  const joined = decoded.join("").trimEnd();
  if (text !== undefined && !joined.endsWith(text)) return;
  const offset = text === undefined ? 0 : joined.length - text.length;
  let position = 0;
  const parts = event.message.flatMap((part, index): (string | { sourceIndex: number })[] => {
    const piece = decoded[index]!;
    if (part.type === "text") {
      const start = Math.max(0, offset - position);
      position += piece.length;
      const clipped = piece.slice(start);
      return clipped ? [clipped] : [];
    }
    if (position < offset || (part.type === "at" && String(part.qq) === String(event.self_id) && text !== undefined)) return [];
    return [{ sourceIndex: index }];
  });
  return parts.every(part => typeof part === "string") ? parts.join("") : parts;
}

export function createOwnerMessageRelay({
  resolveAccount, isMaster, claim, privateCredential,
}: {
  readonly resolveAccount: (id: number, adapter?: Adapter) => OwnerRelayAccount | undefined;
  readonly isMaster: (botId: number, actorId: number) => boolean;
  readonly claim: ReturnType<typeof createRequestClaim>;
  readonly privateCredential: (text: string) => boolean;
}) {
  const drafts = new Map<string, Draft>();
  const snapshots = new Map<string, { groups: readonly Group[]; expires: number; source: AbortSignal }>();
  const contactKey = (origin: NonNullable<ReturnType<typeof idOf>>) => `${origin.adapter}:${origin.botId}:${origin.actorId}`;
  const draftKey = (origin: NonNullable<ReturnType<typeof idOf>>) => `${contactKey(origin)}:${origin.groupId ?? "friend"}`;

  function displayedGroups(event: MessageEvent) {
    const origin = idOf(event);
    if (!origin) return;
    const key = contactKey(origin);
    const stored = snapshots.get(key);
    if (!stored) return;
    if (stored.source !== origin.source || stored.expires <= Date.now()) {
      snapshots.delete(key);
      return;
    }
    return stored.groups;
  }

  function rememberGroups(event: MessageEvent, groups: readonly Group[]) {
    const origin = idOf(event);
    if (!origin || !groups.length || groups.length > 10_000) return;
    const key = contactKey(origin);
    snapshots.delete(key);
    if (snapshots.size >= maximumSnapshots) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(key, { groups: groups.map(item => ({ ...item })), expires: Date.now() + snapshotLifetime, source: origin.source });
  }

  async function handle(event: MessageEvent, scope: Scope) {
    const explicit = prefix.test(event.msg);
    const origin = idOf(event);
    if (!origin) return explicit;
    const key = draftKey(origin);
    const draft = drafts.get(key);
    if (!explicit && !draft) return false;
    const signal = AbortSignal.any([scope.signal, origin.source]);
    const active = () => !signal.aborted && scope.allowed() && isMaster(origin.botId, origin.actorId);
    if (!active() || (explicit && !scope.allowNew)) return explicit;
    const reply = async (text: string) => {
      if (active()) await event.reply(text);
    };
    const clearDraft = () => {
      if (draft && drafts.get(key) === draft) {
        clearTimeout(draft.timer);
        drafts.delete(key);
      }
    };
    if (draft && event.msg === "#取消") {
      clearDraft();
      await reply("已取消发送。");
      return true;
    }
    const command = explicit ? ownerRelayCommand(event.msg) : undefined;
    if ((explicit && !command) || (command?.kind === "list" && (!command.indexes.every(positive) ||
        command.indexes.length > 3 || new Set(command.indexes).size !== command.indexes.length)) ||
        (command && command.kind !== "list" && (!positive(command.target) || (command.botId !== undefined && !positive(command.botId))))) {
      await reply("请指定好友 QQ、群号或不重复的群列表序号（最多 3 个）。");
      return true;
    }
    const botId = command && command.kind !== "list" ? command.botId ?? origin.botId : origin.botId;
    const account = command ? resolveAccount(botId, botId === origin.botId ? origin.adapter : undefined) : draft?.account;
    if (!account || !isMaster(account.botId, origin.actorId) || (!command && draft?.source !== origin.source)) {
      clearDraft();
      await reply("未能确认发送账号及主人权限。");
      return true;
    }
    const permitted = () => active() && isMaster(account.botId, origin.actorId);
    let kind: Kind;
    let ids: readonly number[];
    if (command?.kind === "list") {
      kind = "group";
      const shown = displayedGroups(event);
      if (!shown) {
        await reply("请先在当前机器人的主人好友私聊查询 #群列表，再使用序号发送。");
        return true;
      }
      const selected = command.indexes.map(index => shown[index - 1]?.id);
      if (!selected.every(positive) || new Set(selected).size !== selected.length) {
        await reply("群列表序号无效，请核对已收到的名单。");
        return true;
      }
      ids = selected;
    } else {
      kind = command?.kind ?? draft!.kind;
      ids = [command?.target ?? draft!.id];
    }
    if (kind === "friend" && ids.includes(account.botId)) {
      await reply("请指定发送账号以外的好友。");
      return true;
    }
    const readTargets = async (targets: readonly number[]) => kind === "friend"
      ? account.friendship(targets[0]!).catch(() => undefined)
      : account.groups(signal).then(groups => targets.every(id => groups.some(group => group.id === id)), () => undefined);
    const part = messageParts(event, command?.text);
    if (part === undefined) {
      clearDraft();
      await reply("无法识别要发送的消息正文。");
      return true;
    }
    const empty = typeof part === "string" ? !part.trim() : !part.some(item => typeof item !== "string" || item.trim());
    if (privateCredential(event.msg) || privateCredential(event.raw_message)) {
      clearDraft();
      await reply("已停止发送，请勿转发登录凭据。");
      return true;
    }
    if (empty && command?.kind === "list") {
      await reply("消息不能为空。");
      return true;
    }
    if (!empty) clearDraft();
    const verified = await readTargets(ids);
    if (!permitted()) return true;
    if (!verified) {
      clearDraft();
      await reply(verified === false ? "当前发送账号的名单中没有这个目标。" : "未能核对发送账号的名单。");
      return true;
    }
    if (empty && command) {
      clearDraft();
      if (drafts.size >= maximumSnapshots) {
        await reply("待发送会话过多，请稍后重试。");
        return true;
      }
      const timer = setTimeout(() => {
        if (drafts.get(key)?.timer !== timer) return;
        drafts.delete(key);
        void reply("发送消息超时，已取消。").catch(() => {});
      }, lifetime).unref();
      drafts.set(key, { kind, id: ids[0]!, account, timer, source: origin.source });
      await reply("请发送需要发送的消息，或发送 #取消。");
      return true;
    }
    clearDraft();
    if (empty) return true;
    const body = typeof part === "string" ? part : await readFriendReplyParts(part, event.message, signal, kind === "group");
    if (!permitted()) return true;
    if (!body) {
      await reply("无法读取或发送这种消息内容。");
      return true;
    }
    if (ids.length > 1) await reply("将按已确认的群列表顺序发送，间隔 5 秒。");
    for (const [position, id] of ids.entries()) {
      if (position) {
        await delay(5_000, undefined, { signal }).catch(() => {});
        if (!permitted()) break;
      }
      const recheck = position > 0 || typeof part !== "string";
      if (recheck && !await readTargets([id])) {
        await reply(`${id} 已无法核对，未发送。`);
        continue;
      }
      if (!permitted()) break;
      const status = await claim({
        adapter: origin.adapter, botId: origin.botId,
        flag: JSON.stringify([origin.actorId, origin.groupId, origin.messageId, account.adapter, account.botId, kind, id]),
      }, () => permitted() ? account.send(kind, id, body) : Promise.resolve("unavailable"));
      await reply(status === "confirmed" ? `${id} 的${kind === "friend" ? "私聊" : "群聊"}消息已送达。`
        : status === "unknown" ? `${id} 的发送结果未确认，请先核对原会话。`
          : `${id} 的消息未发出。`);
    }
    return true;
  }

  return { handle, displayedGroups, rememberGroups };
}
