import type { MessageEvent, MessageReply, ReplyOptions } from "./messages.ts";
import type { OwnGroupCardAccount } from "./adapters/own-group-card.ts";

export type CommandContext = Readonly<Pick<
  MessageEvent, "message_type" | "message_id" | "self_id" | "user_id" | "group_id" | "isMaster" | "member" | "likeSelf" | "mentionLike" | "isFriend" |
    "reviewGroupRequest" | "groupRequestScope" | "canReviewGroupRequests" | "uploadFile" | "attachment" | "canReadAttachments" | "adapter" |
    "listCurrentGroupMembers" | "listCheckinGroupMembers" | "privateCredentialSignal" | "canDelegate" | "delegationSignal" | "isDelegated" |
    "profileLikeImageSignal" | "groupMute" | "groupMuteSelf" | "groupWholeMute" | "groupKick" | "groupManageBlacklist" | "groupManageWhitelistAutoUnmute" |
    "groupSetSpecialTitle" | "groupSetAdmin" | "groupMuteRoster" | "groupActivityRoster" | "groupActivitySignal" | "groupSetQuotedEssence" |
    "groupNotifyAll" | "groupReviewQuotedRequest" | "groupListAnnouncements" | "groupPublishAnnouncement" | "groupDeleteAnnouncement" |
    "groupRuleImageDigest" | "groupVote" | "groupVerification" | "privateGroupMute" | "privateGroupWholeMute" | "privateGroupKick"
> & Partial<Pick<MessageEvent, "message" | "raw_message">> & {
  ownGroupCardAccount?: OwnGroupCardAccount;
  atlasMaintenance?: true;
  runtimeDiagnosticsScope?: "milky";
  runtimeStatusScope?: "onebot" | "milky" | "terminal";
  calculationSignal?: AbortSignal;
}>;

export type MessageFallbackContext = CommandContext & Readonly<Pick<MessageEvent, "reply_id" | "sender" | "lookupReply" | "reply">> & {
  readonly isBotMaster: (userId: number) => boolean;
  readonly normalizedMessage: string;
};

export interface CommandForward {
  readonly type: "forward";
  readonly nodes: readonly MessageReply[];
}

export interface QuotedCommandReply {
  readonly type: "quoted";
  readonly message: MessageReply;
  readonly options?: ReplyOptions;
}

export interface DeliveryCommandReply {
  readonly type: "delivery";
  readonly message: MessageReply;
  readonly onDelivered: NonNullable<ReplyOptions["onDelivered"]>;
}

export type CommandReply = MessageReply | CommandForward | QuotedCommandReply | DeliveryCommandReply;
export type CommandHandler = (argument: string, context: CommandContext) => CommandReply | Promise<CommandReply>;
export type MessageFallback = (
  message: string,
  context: MessageFallbackContext,
) => CommandReply | undefined | Promise<CommandReply | undefined>;

export async function sendCommandReply(event: Pick<MessageEvent, "reply" | "forward">, reply: CommandReply): Promise<void> {
  if (typeof reply !== "object" || reply === null || !("type" in reply)) {
    await event.reply(reply);
    return;
  }
  if (reply.type === "quoted") {
    if (reply.options === undefined) await event.reply(reply.message, true);
    else await event.reply(reply.message, true, reply.options);
    return;
  }
  if (reply.type === "delivery") {
    await event.reply(reply.message, false, { onDelivered: reply.onDelivered });
    return;
  }
  if (reply.type !== "forward") {
    await event.reply(reply);
    return;
  }
  if (!Array.isArray(reply.nodes) || !reply.nodes.length) return;
  if (event.forward) {
    try {
      if (await event.forward(reply.nodes)) return;
    } catch {
      await event.reply("合并转发结果未确认，请在聊天中核对。");
      return;
    }
  }
  for (const node of reply.nodes) await event.reply(node);
}

export interface CommandModule {
  readonly name: string;
  readonly commands: Readonly<Record<string, CommandHandler>>;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly fallback?: MessageFallback;
  readonly fallbackFeatures?: (context: MessageFallbackContext) => readonly string[];
}

interface RegisteredCommand {
  readonly handler: CommandHandler;
  readonly names: readonly string[];
}

function commandContext(context: CommandContext): CommandContext {
  const { message_type, message_id, self_id, user_id, group_id, isMaster, member, likeSelf, mentionLike, groupMute, groupMuteSelf, groupWholeMute, groupKick,
    groupManageBlacklist, groupManageWhitelistAutoUnmute, groupSetSpecialTitle, groupSetAdmin, groupMuteRoster,
    groupActivityRoster, groupActivitySignal, groupSetQuotedEssence, groupNotifyAll, groupReviewQuotedRequest, groupListAnnouncements,
    groupPublishAnnouncement, groupDeleteAnnouncement, groupRuleImageDigest, groupVote, groupVerification, privateGroupMute, privateGroupWholeMute, privateGroupKick,
    profileLikeImageSignal, isFriend, reviewGroupRequest,
    groupRequestScope, canReviewGroupRequests, runtimeDiagnosticsScope, runtimeStatusScope, message, raw_message, uploadFile,
    attachment, canReadAttachments, adapter, listCurrentGroupMembers, listCheckinGroupMembers,
    privateCredentialSignal, canDelegate, delegationSignal, isDelegated, ownGroupCardAccount, atlasMaintenance, calculationSignal } = context;
  return {
    message_type, message_id, self_id, user_id, group_id, isMaster, likeSelf, isFriend, message, raw_message,
    reviewGroupRequest, groupRequestScope, canReviewGroupRequests, uploadFile, attachment, canReadAttachments, adapter, listCheckinGroupMembers,
    ...(message_type === "group" && !isDelegated && listCurrentGroupMembers ? { listCurrentGroupMembers } : {}),
    ...(message_type === "group" && !isDelegated && mentionLike ? { mentionLike } : {}),
    ...(message_type === "group" && !isDelegated && groupMute ? { groupMute } : {}),
    ...(message_type === "group" && !isDelegated && groupMuteSelf ? { groupMuteSelf } : {}),
    ...(message_type === "group" && !isDelegated && groupWholeMute ? { groupWholeMute } : {}),
    ...(message_type === "group" && !isDelegated && groupKick ? { groupKick } : {}),
    ...(message_type === "group" && !isDelegated && groupManageBlacklist ? { groupManageBlacklist } : {}),
    ...(message_type === "group" && !isDelegated && groupManageWhitelistAutoUnmute ? { groupManageWhitelistAutoUnmute } : {}),
    ...(message_type === "group" && !isDelegated && groupSetSpecialTitle ? { groupSetSpecialTitle } : {}),
    ...(message_type === "group" && !isDelegated && groupSetAdmin ? { groupSetAdmin } : {}),
    ...(message_type === "group" && !isDelegated && groupMuteRoster ? { groupMuteRoster } : {}),
    ...(message_type === "group" && !isDelegated && groupActivityRoster ? { groupActivityRoster } : {}),
    ...(message_type === "group" && !isDelegated && groupActivitySignal ? { groupActivitySignal } : {}),
    ...(message_type === "group" && !isDelegated && groupSetQuotedEssence ? { groupSetQuotedEssence } : {}),
    ...(message_type === "group" && !isDelegated && groupNotifyAll ? { groupNotifyAll } : {}),
    ...(message_type === "group" && !isDelegated && groupReviewQuotedRequest ? { groupReviewQuotedRequest } : {}),
    ...(message_type === "group" && !isDelegated && groupListAnnouncements ? { groupListAnnouncements } : {}),
    ...(message_type === "group" && !isDelegated && groupPublishAnnouncement ? { groupPublishAnnouncement } : {}),
    ...(message_type === "group" && !isDelegated && groupDeleteAnnouncement ? { groupDeleteAnnouncement } : {}),
    ...(message_type === "group" && !isDelegated && groupRuleImageDigest ? { groupRuleImageDigest } : {}),
    ...(message_type === "group" && !isDelegated && groupVote ? { groupVote } : {}),
    ...(message_type === "group" && !isDelegated && groupVerification ? { groupVerification } : {}),
    ...(message_type === "private" && !isDelegated && privateGroupMute ? { privateGroupMute } : {}),
    ...(message_type === "private" && !isDelegated && privateGroupWholeMute ? { privateGroupWholeMute } : {}),
    ...(message_type === "private" && !isDelegated && privateGroupKick ? { privateGroupKick } : {}),
    ...(!isDelegated && profileLikeImageSignal ? { profileLikeImageSignal } : {}),
    ...(ownGroupCardAccount && !isDelegated ? { ownGroupCardAccount } : {}),
    ...(atlasMaintenance === true && !isDelegated ? { atlasMaintenance } : {}),
    privateCredentialSignal, canDelegate, delegationSignal, isDelegated, calculationSignal,
    ...(runtimeDiagnosticsScope ? { runtimeDiagnosticsScope } : {}),
    ...(runtimeStatusScope ? { runtimeStatusScope } : {}),
    member: member && { is_admin: member.is_admin, is_owner: member.is_owner },
  };
}

function commandFeatureNames(module: string, command: string): readonly string[] {
  if (module === "@lotus-yunzai/group" &&
      /^#(?:全部赞我|(?:我要|给我)?(?:资料卡)?点赞|[赞超操草抄吵炒](?:我|他|她|它|ta))$/iu.test(command)) {
    return ["[group] 资料卡点赞"];
  }
  if (module === "@lotus-yunzai/system" && /^#(?:椰奶)?状态(?:pro)?$/u.test(command)) return ["[system] 状态"];
  if (module === "@lotus-yunzai/system" && command === "#统计") return ["[system] 消息统计"];
  if (module === "@lotus-yunzai/system" && command === "#版本") return ["版本"];
  if (module === "@lotus-yunzai/group" && command === "#更新群名片") return ["自动群名片"];
  return [];
}

export class CommandRegistry {
  readonly #handlers = new Map<string, RegisteredCommand>();
  readonly #fallbacks = new Map<string, { readonly handler: MessageFallback; readonly names: readonly string[];
    readonly features?: CommandModule["fallbackFeatures"] }>();
  readonly #modules = new Set<string>();

  register(name: string, handler: CommandHandler): void {
    this.#checkCommand(name);
    this.#handlers.set(name, { handler, names: [name] });
  }

  hasModule(name: string): boolean {
    return this.#modules.has(name);
  }

  registerModule(module: CommandModule, label = module.name): () => void {
    const { name, fallback, fallbackFeatures } = module;
    if (this.hasModule(name)) {
      throw new Error(`模块已注册：${name}`);
    }
    if (fallback !== undefined && typeof fallback !== "function") {
      throw new Error(`模块 ${name} 的 fallback 须为消息处理函数。`);
    }

    const commands = Object.entries(module.commands);
    const local = new Map<string, RegisteredCommand>();
    for (const [command, handler] of commands) {
      this.#checkCommand(command);
      if (typeof handler !== "function") {
        throw new Error(`模块 ${name} 的指令 ${command} 缺少处理函数。`);
      }
      local.set(command, { handler, names: [name, label, ...commandFeatureNames(name, command)] });
    }

    for (const [alias, target] of Object.entries(module.aliases ?? {})) {
      if (!/^#?[^\s#]+$/u.test(alias) || this.#handlers.has(alias) || local.has(alias)) {
        throw new Error(`无效或重复的指令别名：${alias}`);
      }
      const command = local.get(target);
      if (!command || !Object.hasOwn(module.commands, target)) {
        throw new Error(`指令别名 ${alias} 的目标不在当前模块中。`);
      }
      local.set(alias, command);
    }

    for (const [name, command] of local) {
      this.#handlers.set(name, command);
    }
    if (fallback) {
      const names = [name, label];
      if (name === "@lotus-yunzai/meme") names.push("[meme] 表情合成");
      if (!fallbackFeatures && ["@lotus-yunzai/genshin", "@lotus-yunzai/starrail", "@lotus-yunzai/zzz"].includes(name)) {
        names.push("[gacha] 抽卡记录");
      }
      this.#fallbacks.set(name, { handler: fallback, names, features: fallbackFeatures });
    }
    this.#modules.add(name);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.#modules.delete(name);
      this.#fallbacks.delete(name);
      for (const command of local.keys()) {
        this.#handlers.delete(command);
      }
    };
  }

  #checkCommand(name: string): void {
    if (!/^#[^\s#]+$/u.test(name)) {
      throw new Error(`无效的指令名：${name}`);
    }

    if (this.#handlers.has(name)) {
      throw new Error(`指令已注册：${name}`);
    }
  }

  async dispatch(
    message: string,
    context: CommandContext = { message_type: "terminal", isMaster: false },
    allowed?: (names: readonly string[]) => boolean,
  ): Promise<CommandReply | undefined> {
    const input = message.trim();
    const separator = input.search(/\s/u);
    const name = separator === -1 ? input : input.slice(0, separator);
    const argument = separator === -1 ? "" : input.slice(separator).trimStart();
    const command = this.#handlers.get(name);
    if (!command || (allowed && !allowed(command.names))) return;

    return command.handler(argument, commandContext(context));
  }

  async dispatchFallback(
    event: MessageEvent,
    allowed: (names: readonly string[]) => boolean,
    isBotMaster: MessageFallbackContext["isBotMaster"],
    normalizedMessage = event.msg,
  ): Promise<CommandReply | undefined> {
    for (const { handler, names, features } of this.#fallbacks.values()) {
      if (!features && !allowed(names)) continue;
      const context = {
        ...commandContext(event), sender: event.sender, reply_id: event.reply_id, lookupReply: event.lookupReply,
        reply: event.reply, isBotMaster, normalizedMessage,
      };
      if (features && !allowed([...names, ...features(context)])) continue;
      const reply = await handler(event.msg, context);
      if (reply !== undefined) return reply;
    }
  }
}
