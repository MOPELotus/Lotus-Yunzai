import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { setTimeout as delay } from "node:timers/promises";
import { delegationSession } from "./command-delegation.ts";
import { readFriendReplyParts, type OwnerFriendReplyBody } from "./adapters/owner-friend-reply.ts";
import { chatFileRelaySource, isChatFileName, maxChatFileBytes, type ChatFile } from "./chat-files.ts";
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
  uploadFile?(target: { group_id: number } | { user_id: number }, file: ChatFile, signal: AbortSignal): Promise<CheckinNotifyDelivery>;
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
  readonly reservation: symbol;
}

const direct = /^#(\d*)\s?(发好友|发群聊)\s?(\d+)\s?([\s\S]*)$/u;
const numbered = /^#发群列表\s?(\d+(?:,\d+)*)(\s?)([\s\S]*)$/u;
const prefix = /^#(?:\d*\s?(?:发好友|发群聊)|发群列表)/u;
const lifetime = 120_000;
const snapshotLifetime = 300_000;
const maximumSnapshots = 128;
const fileWindowMs = 15_000;
const maximumFiles = 4096;
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
  const fileOrigin = event[chatFileRelaySource];
  const source = event[delegationSession]?.signal ?? fileOrigin?.signal;
  const { self_id: botId, user_id: actorId, message_id: messageId, group_id: groupId, sender } = event;
  const adapter: Adapter = event.adapter ?? "onebot";
  const group = event.message_type === "group" && positive(groupId) && event.sub_type !== "anonymous";
  const friend = event.message_type === "private" && event.sub_type === "friend" && groupId === undefined;
  const receipt = Number.isSafeInteger(messageId) ? messageId : fileOrigin?.notice ? fileOrigin.reference : undefined;
  if (!source || source.aborted || event.isDelegated || (event.attachmentOnly && !fileOrigin?.notice) ||
      (!group && !friend) || !positive(botId) || !positive(actorId) || receipt === undefined ||
      (sender?.user_id !== undefined && sender.user_id !== actorId && sender.user_id !== String(actorId))) return;
  return { botId, actorId, adapter, source, receipt, groupId, fileOrigin };
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
    if (part.type === "at" && String(part.qq) === String(event.self_id) && text !== undefined) return [];
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
  const recentFiles = new Map<string, { expires: number; notice?: true; reservation?: symbol; consumed?: true }>();
  const contactKey = (origin: NonNullable<ReturnType<typeof idOf>>) => `${origin.adapter}:${origin.botId}:${origin.actorId}`;
  const draftKey = (origin: NonNullable<ReturnType<typeof idOf>>) => `${contactKey(origin)}:${origin.groupId ?? "friend"}`;
  const fileKeyFor = (origin: NonNullable<ReturnType<typeof idOf>>) => `${draftKey(origin)}:${origin.fileOrigin?.reference}`;

  function recentFile(key: string) {
    const found = recentFiles.get(key);
    if (found && found.expires > Date.now()) return found;
  }

  function rememberFile(key: string, state: Omit<NonNullable<ReturnType<typeof recentFile>>, "expires">) {
    const now = Date.now();
    for (const [oldKey, record] of recentFiles) {
      if (record.expires > now) break;
      recentFiles.delete(oldKey);
    }
    recentFiles.delete(key);
    if (recentFiles.size >= maximumFiles) recentFiles.delete(recentFiles.keys().next().value!);
    recentFiles.set(key, { ...state, expires: now + fileWindowMs });
  }

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

  function reserveFileNotice(event: MessageEvent, allowed: boolean) {
    const origin = idOf(event);
    if (!origin?.fileOrigin?.notice || !event.attachment) return;
    const key = fileKeyFor(origin);
    const recent = recentFile(key);
    if (recent) return recent.reservation;
    const draft = drafts.get(draftKey(origin));
    const reservation = allowed && draft?.source === origin.source && isMaster(origin.botId, origin.actorId) &&
      isMaster(draft.account.botId, origin.actorId) ? draft.reservation : undefined;
    rememberFile(key, { notice: true, reservation });
    return reservation;
  }

  function acceptsFileFollowup(event: MessageEvent) {
    const origin = idOf(event);
    if (!origin?.fileOrigin || event.msg || !event.attachment || !Array.isArray(event.message) ||
        event.message.length !== 1 || event.message[0]?.type !== "file") return false;
    const draft = drafts.get(draftKey(origin));
    const recent = recentFile(fileKeyFor(origin));
    return !!draft && draft.source === origin.source && (!origin.fileOrigin.notice || origin.fileOrigin.reservation === draft.reservation) &&
      (!recent?.notice || recent.reservation === draft.reservation) &&
      isMaster(origin.botId, origin.actorId) && isMaster(draft.account.botId, origin.actorId);
  }

  async function handle(event: MessageEvent, scope: Scope) {
    const explicit = prefix.test(event.msg);
    const origin = idOf(event);
    if (!origin) return explicit;
    const key = draftKey(origin);
    const draft = drafts.get(key);
    const onlyFile = !explicit && !event.msg && event.attachment && (event.canReadAttachments || origin.fileOrigin?.notice) &&
      Array.isArray(event.message) && event.message.length === 1 && event.message[0]?.type === "file";
    const fileKey = onlyFile && origin.fileOrigin ? fileKeyFor(origin) : undefined;
    const already = fileKey && recentFile(fileKey);
    if (already && already.consumed) return true;
    if (already && already.notice && already.reservation !== draft?.reservation) return false;
    if (origin.fileOrigin?.notice && (!draft || origin.fileOrigin.reservation !== draft.reservation)) return false;
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
      await reply($t("lib.owner-message-relay.text_d5c45fed1c"));
      return true;
    }
    const command = explicit ? ownerRelayCommand(event.msg) : undefined;
    if ((explicit && !command) || (command?.kind === "list" && (!command.indexes.every(positive) ||
        command.indexes.length > 3 || new Set(command.indexes).size !== command.indexes.length)) ||
        (command && command.kind !== "list" && (!positive(command.target) || (command.botId !== undefined && !positive(command.botId))))) {
      await reply($t("lib.owner-message-relay.text_e877de98d5"));
      return true;
    }
    const botId = command && command.kind !== "list" ? command.botId ?? origin.botId : origin.botId;
    const account = command ? resolveAccount(botId, botId === origin.botId ? origin.adapter : undefined) : draft?.account;
    if (!account || !isMaster(account.botId, origin.actorId) || (!command && draft?.source !== origin.source)) {
      clearDraft();
      await reply($t("lib.owner-message-relay.text_855554bc88"));
      return true;
    }
    const permitted = () => active() && isMaster(account.botId, origin.actorId);
    let kind: Kind;
    let ids: readonly number[];
    if (command?.kind === "list") {
      kind = "group";
      const shown = displayedGroups(event);
      if (!shown) {
        await reply($t("lib.owner-message-relay.text_b41dfa3982"));
        return true;
      }
      const selected = command.indexes.map(index => shown[index - 1]?.id);
      if (!selected.every(positive) || new Set(selected).size !== selected.length) {
        await reply($t("lib.owner-message-relay.text_4dad130baa"));
        return true;
      }
      ids = selected;
    } else {
      kind = command?.kind ?? draft!.kind;
      ids = [command?.target ?? draft!.id];
    }
    if (kind === "friend" && ids.includes(account.botId)) {
      await reply($t("lib.owner-message-relay.text_d3286cd5b3"));
      return true;
    }
    const readTargets = async (targets: readonly number[]) => kind === "friend"
      ? account.friendship(targets[0]!).catch(() => undefined)
      : account.groups(signal).then(groups => targets.every(id => groups.some(group => group.id === id)), () => undefined);
    const part = messageParts(event, command?.text);
    if (part === undefined) {
      clearDraft();
      await reply($t("lib.owner-message-relay.text_4bc353519c"));
      return true;
    }
    const source = event.message;
    const indexedParts = typeof part === "string" || typeof source === "string" ? [] : part.flatMap(value => {
      const segment = typeof value === "string" ? undefined : source[value.sourceIndex];
      return segment ? [segment] : [];
    });
    if (indexedParts.some(segment => segment.type === "reply")) {
      clearDraft();
      await reply($t("lib.owner-message-relay.text_5f2374aeaa"));
      return true;
    }
    const includesFile = indexedParts.some(segment => segment.type === "file");
    if (includesFile && (indexedParts.length !== 1 || typeof part === "string" ||
        part.some(value => typeof value === "string" && value.trim()))) {
      clearDraft();
      await reply($t("lib.owner-message-relay.text_4d8adfec23"));
      return true;
    }
    const empty = typeof part === "string" ? !part.trim() : !part.some(item => typeof item !== "string" || item.trim());
    if (privateCredential(event.msg) || privateCredential(event.raw_message)) {
      clearDraft();
      await reply($t("lib.owner-message-relay.text_e37858e135"));
      return true;
    }
    if (empty && command?.kind === "list") {
      await reply($t("lib.owner-message-relay.text_c9a94da0c0"));
      return true;
    }
    if (fileKey) rememberFile(fileKey, { consumed: true });
    if (!empty) clearDraft();
    const verified = await readTargets(ids);
    if (!permitted()) return true;
    if (!verified) {
      clearDraft();
      await reply(verified === false ? $t("lib.owner-message-relay.text_92087bd426") : $t("lib.owner-message-relay.text_ff74f15a0e"));
      return true;
    }
    if (empty && command) {
      clearDraft();
      if (drafts.size >= maximumSnapshots) {
        await reply($t("lib.owner-message-relay.text_67b6445567"));
        return true;
      }
      const timer = setTimeout(() => {
        if (drafts.get(key)?.timer !== timer) return;
        drafts.delete(key);
        void reply($t("lib.owner-message-relay.text_8e078a936f")).catch(() => {});
      }, lifetime).unref();
      drafts.set(key, { kind, id: ids[0]!, account, timer, source: origin.source, reservation: Symbol() });
      await reply($t("lib.owner-message-relay.text_6b96a11e70"));
      return true;
    }
    clearDraft();
    if (empty) return true;
    let body: MessageReply | undefined;
    let file: ChatFile | undefined;
    if (includesFile) {
      const attachment = (event.canReadAttachments || origin.fileOrigin?.notice) && event.attachment;
      if (account.uploadFile && attachment && isChatFileName(attachment.name)) {
        const bytes = await attachment.read(signal).catch(() => undefined);
        if (bytes && bytes.byteLength > 0 && bytes.byteLength <= maxChatFileBytes &&
            (attachment.size === undefined || attachment.size === bytes.byteLength)) file = { name: attachment.name, bytes };
      }
    } else {
      body = typeof part === "string" ? part : await readFriendReplyParts(part, source, signal, kind === "group");
    }
    if (!permitted()) return true;
    if (!body && !file) {
      await reply($t("lib.owner-message-relay.text_4cdff4b2c5"));
      return true;
    }
    if (ids.length > 1) await reply($t("lib.owner-message-relay.text_0fcb300110"));
    for (const [position, id] of ids.entries()) {
      if (position) {
        await delay(5_000, undefined, { signal }).catch(() => {});
        if (!permitted()) break;
      }
      const recheck = position > 0 || typeof part !== "string";
      if (recheck && !await readTargets([id])) {
        await reply($t("lib.owner-message-relay.text_609ad32991", { "id": id }));
        continue;
      }
      if (!permitted()) break;
      const status = await claim({
        adapter: origin.adapter, botId: origin.botId,
        flag: JSON.stringify([origin.actorId, origin.groupId, origin.receipt, account.adapter, account.botId, kind, id]),
      }, () => {
        if (!permitted()) return Promise.resolve("unavailable");
        if (file && account.uploadFile) {
          return account.uploadFile(kind === "friend" ? { user_id: id } : { group_id: id }, file, signal);
        }
        return body === undefined ? Promise.resolve("unavailable") : account.send(kind, id, body);
      });
      await reply(status === "confirmed" ? $t("lib.owner-message-relay.text_c2915b086b", { "id": id, "value2": kind === "friend" ? $t("lib.owner-message-relay.text_6add2714c4") : $t("lib.owner-message-relay.text_35b49ee58a") })
        : status === "unknown" ? $t("lib.owner-message-relay.text_75e189b3d1", { "id": id })
          : $t("lib.owner-message-relay.text_96f9c30b6f", { "id": id }));
    }
    return true;
  }

  return { handle, displayedGroups, rememberGroups, reserveFileNotice, acceptsFileFollowup };
}
