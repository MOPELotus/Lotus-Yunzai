import type { AcquireRoleArchiveLock } from "@lotus-yunzai/storage";
import type { CommandModule, MessageFallbackContext } from "./commands.ts";
import type { MessageEvent } from "./messages.ts";
import {
  createGameCharacterAliasManager, matchGameCharacterAliasCommand, readLegacyCharacterAliasMode,
  validCharacterAlias, type AliasGame,
} from "./game-character-aliases.ts";

const waitingTime = 120_000;
const maxWaitingPerConnection = 128;
const features = { gs: "[genshin] 角色别名", sr: "[starrail] 角色别名" };
const cancel = /^(?:取消|#取消(?:设置)?(?:别名|昵称))$/u;
const activeId = (id: number | undefined): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
type Conversation = Pick<MessageFallbackContext, "normalizedMessage" | "isDelegated" | "self_id" | "user_id" |
  "group_id" | "message_type" | "groupActivitySignal" | "privateCredentialSignal" | "adapter" | "reply_id" | "attachment" | "message">;

function match(message: string) {
  if (message.length > 160 || cancel.test(message) || matchGameCharacterAliasCommand(message)) return;
  const legacyPrefix = message.replace(/^(?:#星铁sr|#?(?:[*＊]?sr|＊))/u, "#星铁");
  const parts = /^(?:#(原神|星铁|崩铁)?|(\*))\s*(.+)$/u.exec(legacyPrefix);
  if (!parts) return;
  const game: AliasGame = parts[2] || (parts[1] && parts[1] !== "原神") ? "sr" : "gs";
  const body = parts[3]!;
  if (game === "gs" && /^(?:绝区零|绝区)/u.test(body)) return;
  const remove = /^删除(?:别名|昵称)\s*(.+)$/u.exec(body)?.[1]?.trim();
  if (remove) return { game, type: "delete" as const, name: remove };
  const set = /^(设置|配置|添加)\s*(.+?)\s*(?:别名|昵称)$/u.exec(body);
  const role = set?.[2]?.trim();
  if (role && (set?.[1] !== "添加" || game === "sr")) return { game, type: "begin" as const, name: role };
  const name = /^(.+?)\s*(?:别名|昵称)$/u.exec(body)?.[1]?.trim();
  if (name) return { game, type: "list" as const, name };
}

function scope(context: Conversation) {
  if (context.isDelegated || !activeId(context.self_id) || !activeId(context.user_id) || context.self_id === context.user_id) return;
  const group = context.message_type === "group" ? context.group_id : undefined;
  if (context.message_type !== "private" && !activeId(group)) return;
  const connection = group ? context.groupActivitySignal : context.privateCredentialSignal;
  if (!connection || connection.aborted) return;
  return { connection, key: `${context.adapter ?? "onebot"}:${context.self_id}:${group ?? "private"}:${context.user_id}` };
}

type Pending = { game: AliasGame; role: string; expiry: AbortSignal };

function continuationText(context: Conversation) {
  if (context.reply_id !== undefined || context.attachment || typeof context.message !== "string" &&
      (!context.message?.length || context.message.some(part => part.type !== "text"))) return;
  const input = context.normalizedMessage.trim();
  if (cancel.test(input)) return { cancel: true as const };
  if (input.length > 320 || /^[#/*%％]/u.test(input)) return;
  const aliases = input.split(/\s+/u);
  if (aliases.length <= 12 && aliases.every(validCharacterAlias)) return { cancel: false as const, aliases };
}

export function legacyCharacterAliasCommands(lockFile: AcquireRoleArchiveLock, signal: AbortSignal, root?: string):
  CommandModule & { acceptsContinuation(event: MessageEvent): boolean } {
  const store = createGameCharacterAliasManager(lockFile, signal, root);
  const pending = new WeakMap<AbortSignal, Map<string, Pending>>();

  function waiting(context: Conversation) {
    const session = scope(context);
    const waits = session && pending.get(session.connection);
    const entry = session && waits?.get(session.key);
    if (!session || !waits || !entry) return;
    if (entry.expiry.aborted) {
      waits.delete(session.key);
      return;
    }
    const input = continuationText(context);
    if (input) return { ...session, waits, entry, input };
  }
  const matchedWaits = new WeakMap<MessageFallbackContext, NonNullable<ReturnType<typeof waiting>>>();

  async function permitted(context: MessageFallbackContext, game: AliasGame, connection: AbortSignal) {
    const active = () => !signal.aborted && !connection.aborted;
    if (!active() || !activeId(context.user_id) || !activeId(context.self_id)) return false;
    if (context.isBotMaster(context.user_id)) return true;
    if (context.message_type !== "group") return false;
    const mode = await readLegacyCharacterAliasMode(game, root).catch(() => 2);
    if (!active() || mode === 2) return false;
    if (mode === 1) {
      const members = await context.groupActivityRoster?.("management").catch(() => undefined);
      const role = members?.find(member => member.userId === context.user_id)?.role;
      return active() && (role === "admin" || role === "owner") && !!members?.some(member => member.userId === context.self_id);
    }
    const members = await context.listCurrentGroupMembers?.().catch(() => undefined);
    return active() && !!members?.some(member => member.id === context.user_id) && !!members?.some(member => member.id === context.self_id);
  }

  return {
    name: "@lotus-yunzai/legacy-character-alias",
    commands: {},
    acceptsContinuation: event => !signal.aborted && !!waiting({ ...event, normalizedMessage: event.msg }),
    fallbackFeatures(context) {
      if (signal.aborted || context.isDelegated) return [];
      const next = waiting(context);
      if (next) matchedWaits.set(context, next);
      const game = match(context.normalizedMessage)?.game ?? next?.entry.game;
      return game ? [features[game], game === "gs" ? "@lotus-yunzai/genshin" : "@lotus-yunzai/starrail"] : [];
    },
    async fallback(_message, context) {
      if (signal.aborted || context.isDelegated) return;
      const command = match(context.normalizedMessage);
      if (command?.type === "list") {
        const result = await store.find(command.game, command.name).catch(() => undefined);
        if (!result || signal.aborted) return;
        const senderName = `${result.role}别名，${result.aliases.length}个`;
        return { type: "forward", senderName, nodes: [`${senderName}\n${result.aliases.map((alias, index) => `${index + 1}.${alias}`).join("\n").slice(0, 3_000)}`] };
      }
      const session = scope(context);
      if (!session) return;
      if (!command) {
        const next = matchedWaits.get(context);
        if (!next || next.entry.expiry.aborted || next.waits.get(next.key) !== next.entry) return;
        next.waits.delete(next.key);
        if (next.input.cancel) return "已取消设置角色别名。";
        const { game, role } = next.entry;
        return store.run({ game, type: "legacy-set", role, aliases: next.input.aliases }, context, {
          permitted: () => permitted(context, game, next.entry.expiry),
          active: () => !next.entry.expiry.aborted,
        });
      }
      const canWrite = () => permitted(context, command.game, session.connection);
      if (command.type === "delete") {
        return store.run({ game: command.game, type: "legacy-delete", alias: command.name }, context, {
          permitted: canWrite,
          active: () => !session.connection.aborted,
        });
      }
      if (!await canWrite()) return "暂无权限修改角色别名。";
      const result = await store.find(command.game, command.name).catch(() => undefined);
      if (!result) return "未找到该角色。";
      if (session.connection.aborted || signal.aborted) return;
      const waits = pending.get(session.connection) ?? new Map<string, Pending>();
      for (const [key, entry] of waits) if (entry.expiry.aborted) waits.delete(key);
      if (!waits.has(session.key) && waits.size >= maxWaitingPerConnection) return "当前等待设置的请求过多，请稍后重试。";
      const expiry = AbortSignal.any([session.connection, signal, AbortSignal.timeout(waitingTime)]);
      waits.set(session.key, { game: command.game, role: result.role, expiry });
      pending.set(session.connection, waits);
      return `请发送${result.role}别名，多个用空格隔开。发送“取消”可退出。`;
    },
  };
}
