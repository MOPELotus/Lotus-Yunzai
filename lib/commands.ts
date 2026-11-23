import { forGameCommandSender } from "@lotus-yunzai/account";
import type { LegacyPanelRecoveryOffer } from "./legacy-panel-recovery-flow.ts";
import { sendBatchedImageForward, type BatchedImageForward } from "@lotus-yunzai/skia/forward-images";
import type { MessageEvent, MessageReply, ReplyOptions } from "./messages.ts";
import type { OwnGroupCardAccount } from "./adapters/own-group-card.ts";
import type { NoticeSettingsContext } from "../plugins/group/notice-settings.ts";
import { ownerContactListSession } from "./owner-contact-list.ts";
import { groupExportSession } from "./group-member-export.ts";
import type { PanelTransferAccess } from "./panel-transfer-command.ts";

export type CommandContext = Readonly<Pick<
  MessageEvent, "message_type" | "message_id" | "self_id" | "user_id" | "group_id" | "isMaster" | "member" | "likeSelf" | "mentionLike" | "isFriend" |
    "reviewGroupRequest" | "groupRequestScope" | "canReviewGroupRequests" | "uploadFile" | "deliverMedia" | "sendMusicCard" |
    "attachment" | "canReadAttachments" | "adapter" | "inlineImageByteLimit" | "isNapCat" |
    "listCurrentGroupMembers" | "listCheckinGroupMembers" | "privateCredentialSignal" | "canDelegate" | "delegationSignal" | "isDelegated" |
    "profileLikeImageSignal" | "groupMute" | "groupMuteSelf" | "groupWholeMute" | "groupKick" | "groupKickInactive" | "groupManageBlacklist" | "groupManageWhitelistAutoUnmute" |
    "groupSetSpecialTitle" | "groupSetAdmin" | "setGroupName" | "groupMuteRoster" | "groupActivityRoster" | "groupActivitySignal" | "groupSetQuotedEssence" |
    "groupNotifyAll" | "groupReviewQuotedRequest" | "groupReviewPendingJoin" | "groupReviewAllPendingJoins" | "groupListPendingJoinRequests" | "listPendingGroupInvitations" |
    "listPendingFriendRequests" | "reviewPendingFriendRequest" | "reviewPendingGroupInvitation" | "reviewQuotedGroupInvitation" |
    "reviewAllPendingFriendRequests" | "reviewAllPendingGroupInvitations" |
    "sendOwnerFriendReply" | "sendQuotedOwnerFriendReply" |
    "groupListAnnouncements" | "groupPublishAnnouncement" | "groupDeleteAnnouncement" |
    "groupRuleImageDigest" | "groupVote" | "groupVerification" | "privateGroupMute" | "privateGroupWholeMute" | "privateGroupKick"
> & Partial<Pick<MessageEvent, "message" | "raw_message" | "reply">> & {
  ownGroupCardAccount?: OwnGroupCardAccount;
  atlasMaintenance?: true;
  runtimeDiagnosticsScope?: "milky";
  runtimeStatusScope?: "onebot" | "milky" | "terminal";
  calculationSignal?: AbortSignal;
  authorizeOfficialNoticePush?: () => boolean;
  authorizeCheckinOwner?: () => boolean;
}>;

export type MessageFallbackContext = CommandContext & Readonly<Pick<MessageEvent,
  "reply_id" | "sender" | "lookupReply" | "lookupMediaReply" | "reply" | "forward" |
  "sub_type" | "verifyOwnGroupMembership" | typeof ownerContactListSession | typeof groupExportSession>> & {
  readonly isBotMaster: (userId: number) => boolean;
  readonly normalizedMessage: string;
  readonly canManagePackages?: true;
  readonly configureNoticeSettings?: NoticeSettingsContext["configureNoticeSettings"];
  readonly groupOriginalSignal?: AbortSignal;
  readonly characterGallerySignal?: AbortSignal;
  readonly panelTransfer?: PanelTransferAccess;
  readonly offerLegacyPanelRecovery?: LegacyPanelRecoveryOffer;
  readonly readCharacterGalleryImages?: () => Promise<readonly (Uint8Array | undefined)[] | "too-many">;
};

export interface CommandForward {
  readonly type: "forward";
  readonly nodes: readonly MessageReply[];
  readonly batchSize?: number;
  readonly senderName?: string;
  readonly recallSeconds?: number;
  readonly onDelivered?: () => void | Promise<void>;
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

export interface RecallableCommandReply {
  readonly type: "recallable";
  readonly message: MessageReply;
  readonly seconds: number;
}

export type CommandReply = MessageReply | CommandForward | QuotedCommandReply | DeliveryCommandReply | RecallableCommandReply | BatchedImageForward;
export type CommandHandler = (argument: string, context: CommandContext) => CommandReply | Promise<CommandReply>;
export type MessageFallback = (
  message: string,
  context: MessageFallbackContext,
) => CommandReply | undefined | Promise<CommandReply | undefined>;

export async function sendCommandReply(event: Pick<MessageEvent, "reply" | "forward">, reply: CommandReply): Promise<void> {
  if (Array.isArray(reply) && reply.length === 0) return;
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
  if (reply.type === "recallable") {
    await event.reply(reply.message, false, { recallMsg: reply.seconds, recallOriginal: false });
    return;
  }
  if (reply.type === "forward-image-batches") {
    const notice = await sendBatchedImageForward(reply, event.forward?.bind(event));
    if (notice) await event.reply(notice);
    return;
  }
  if (reply.type !== "forward") {
    await event.reply(reply);
    return;
  }
  if (!Array.isArray(reply.nodes) || !reply.nodes.length) return;
  const count = typeof reply.batchSize === "number" && Number.isSafeInteger(reply.batchSize) && reply.batchSize > 0
    ? reply.batchSize
    : reply.nodes.length;
  let confirmed = true;
  const recall = reply.recallSeconds === undefined ? undefined : { recallMsg: reply.recallSeconds, recallOriginal: false };
  for (let start = 0; start < reply.nodes.length; start += count) {
    const nodes = reply.nodes.slice(start, start + count);
    if (event.forward) {
      try {
        if (await (recall ? event.forward(nodes, reply.senderName, recall) : event.forward(nodes, reply.senderName))) continue;
      } catch {
        await event.reply("合并转发结果未确认，请在聊天中核对。");
        return;
      }
    }
    confirmed = false;
    for (const node of nodes) {
      if (recall) await event.reply(node, false, recall);
      else await event.reply(node);
    }
  }
  if (confirmed) await reply.onDelivered?.();
}

export interface CommandModule {
  readonly name: string;
  readonly commands: Readonly<Record<string, CommandHandler>>;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly fallback?: MessageFallback;
  readonly fallbackFeatures?: (context: MessageFallbackContext) => readonly string[] | Promise<readonly string[]>;
}

interface RegisteredCommand {
  readonly handler: CommandHandler;
  readonly names: readonly string[];
}

const checkinAuthorityModules = new Set([
  "@lotus-yunzai/account", "@lotus-yunzai/checkin-admin", "@lotus-yunzai/checkin-roster",
  "@lotus-yunzai/checkin-plan", "@lotus-yunzai/checkin-schedule-settings",
]);

function commandContext(context: CommandContext, module?: string): CommandContext {
  const { message_type, message_id, self_id, user_id, group_id, isMaster, member, likeSelf, mentionLike, groupMute, groupMuteSelf, groupWholeMute, groupKick,
    groupKickInactive, groupManageBlacklist, groupManageWhitelistAutoUnmute, groupSetSpecialTitle, groupSetAdmin, setGroupName, groupMuteRoster,
    groupActivityRoster, groupActivitySignal, groupSetQuotedEssence, groupNotifyAll, groupReviewQuotedRequest, groupReviewPendingJoin, groupReviewAllPendingJoins,
    groupListPendingJoinRequests, listPendingGroupInvitations, reviewPendingGroupInvitation, reviewQuotedGroupInvitation,
    listPendingFriendRequests, reviewPendingFriendRequest, reviewAllPendingFriendRequests, reviewAllPendingGroupInvitations,
    sendOwnerFriendReply, sendQuotedOwnerFriendReply, groupListAnnouncements,
    groupPublishAnnouncement, groupDeleteAnnouncement, groupRuleImageDigest, groupVote, groupVerification, privateGroupMute, privateGroupWholeMute, privateGroupKick,
    profileLikeImageSignal, isFriend, reviewGroupRequest,
    groupRequestScope, canReviewGroupRequests, runtimeDiagnosticsScope, runtimeStatusScope, message, raw_message, uploadFile, deliverMedia, sendMusicCard,
    attachment, canReadAttachments, adapter, inlineImageByteLimit, isNapCat, listCurrentGroupMembers, listCheckinGroupMembers,
    privateCredentialSignal, canDelegate, delegationSignal, isDelegated, ownGroupCardAccount, atlasMaintenance, calculationSignal,
    authorizeOfficialNoticePush, authorizeCheckinOwner,
    reply } = context;
  const checkinOwner = module && checkinAuthorityModules.has(module) ? authorizeCheckinOwner : undefined;
  return {
    message_type, message_id, self_id, user_id, group_id, isMaster, likeSelf, isFriend, message, raw_message,
    reviewGroupRequest, groupRequestScope, canReviewGroupRequests, uploadFile, attachment, canReadAttachments, adapter, inlineImageByteLimit, listCheckinGroupMembers,
    ...(!isDelegated && deliverMedia ? { deliverMedia } : {}),
    ...(!isDelegated && sendMusicCard ? { sendMusicCard } : {}),
    ...(!isDelegated && isNapCat ? { isNapCat } : {}),
    ...(message_type === "group" && !isDelegated && listCurrentGroupMembers ? { listCurrentGroupMembers } : {}),
    ...(message_type === "group" && !isDelegated && mentionLike ? { mentionLike } : {}),
    ...(message_type === "group" && !isDelegated && groupMute ? { groupMute } : {}),
    ...(message_type === "group" && !isDelegated && groupMuteSelf ? { groupMuteSelf } : {}),
    ...(message_type === "group" && !isDelegated && groupWholeMute ? { groupWholeMute } : {}),
    ...(message_type === "group" && !isDelegated && groupKick ? { groupKick } : {}),
    ...(message_type === "group" && !isDelegated && groupKickInactive ? { groupKickInactive } : {}),
    ...(message_type === "group" && !isDelegated && groupManageBlacklist ? { groupManageBlacklist } : {}),
    ...(message_type === "group" && !isDelegated && groupManageWhitelistAutoUnmute ? { groupManageWhitelistAutoUnmute } : {}),
    ...(message_type === "group" && !isDelegated && groupSetSpecialTitle ? { groupSetSpecialTitle } : {}),
    ...(message_type === "group" && !isDelegated && groupSetAdmin ? { groupSetAdmin } : {}),
    ...(message_type !== "terminal" && !isDelegated && setGroupName ? { setGroupName } : {}),
    ...(message_type === "group" && !isDelegated && groupMuteRoster ? { groupMuteRoster } : {}),
    ...(message_type === "group" && !isDelegated && groupActivityRoster ? { groupActivityRoster } : {}),
    ...(message_type === "group" && !isDelegated && groupActivitySignal ? { groupActivitySignal } : {}),
    ...(message_type === "group" && !isDelegated && groupSetQuotedEssence ? { groupSetQuotedEssence } : {}),
    ...(message_type === "group" && !isDelegated && groupNotifyAll ? { groupNotifyAll } : {}),
    ...(message_type === "group" && !isDelegated && groupReviewQuotedRequest ? { groupReviewQuotedRequest } : {}),
    ...(message_type === "group" && !isDelegated && groupListPendingJoinRequests ? { groupListPendingJoinRequests } : {}),
    ...(message_type === "private" && !isDelegated && listPendingGroupInvitations ? { listPendingGroupInvitations } : {}),
    ...(message_type === "private" && !isDelegated && reviewPendingGroupInvitation ? { reviewPendingGroupInvitation } : {}),
    ...(message_type === "private" && !isDelegated && reviewAllPendingGroupInvitations ? { reviewAllPendingGroupInvitations } : {}),
    ...(message_type === "private" && !isDelegated && reviewQuotedGroupInvitation ? { reviewQuotedGroupInvitation } : {}),
    ...(message_type === "private" && !isDelegated && listPendingFriendRequests ? { listPendingFriendRequests } : {}),
    ...(message_type === "private" && !isDelegated && reviewPendingFriendRequest ? { reviewPendingFriendRequest } : {}),
    ...(message_type === "private" && !isDelegated && reviewAllPendingFriendRequests ? { reviewAllPendingFriendRequests } : {}),
    ...(message_type === "private" && !isDelegated && sendOwnerFriendReply ? { sendOwnerFriendReply } : {}),
    ...(message_type === "private" && !isDelegated && sendQuotedOwnerFriendReply ? { sendQuotedOwnerFriendReply } : {}),
    ...(message_type === "group" && !isDelegated && groupReviewPendingJoin ? { groupReviewPendingJoin } : {}),
    ...(message_type === "group" && !isDelegated && groupReviewAllPendingJoins ? { groupReviewAllPendingJoins } : {}),
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
    ...(module === "@lotus-yunzai/notice" && authorizeOfficialNoticePush && !isDelegated ? { authorizeOfficialNoticePush } : {}),
    ...(checkinOwner ? { authorizeCheckinOwner: checkinOwner } : {}),
    ...(message_type !== "terminal" && !isDelegated &&
      (isMaster || atlasMaintenance === true || (module === "@lotus-yunzai/checkin-plan" && checkinOwner?.())) && reply ? { reply } : {}),
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
  if (module === "@lotus-yunzai/system" && /^#状态(?:[Pp]ro)?$/u.test(command)) return ["[system] 状态"];
  if (module === "@lotus-yunzai/system" && command === "#统计") return ["[system] 消息统计"];
  if (module === "@lotus-yunzai/system" && command === "#版本") return ["版本"];
  if (module === "@lotus-yunzai/group" && command === "#更新群名片") return ["自动群名片"];
  return [];
}

export class CommandRegistry {
  readonly #handlers = new Map<string, RegisteredCommand>();
  readonly #fallbacks = new Map<string, { readonly handler: MessageFallback; readonly names: readonly string[];
    readonly features?: CommandModule["fallbackFeatures"]; readonly trustedLegacyPanelRecovery: boolean }>();
  readonly #modules = new Set<string>();

  register(name: string, handler: CommandHandler): void {
    this.#checkCommand(name);
    this.#handlers.set(name, { handler, names: [name] });
  }

  hasModule(name: string): boolean {
    return this.#modules.has(name);
  }

  registerModule(module: CommandModule, label = module.name,
    { trustedLegacyPanelRecovery = false }: { readonly trustedLegacyPanelRecovery?: boolean } = {}): () => void {
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
      this.#fallbacks.set(name, { handler: fallback, names, features: fallbackFeatures, trustedLegacyPanelRecovery });
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
    let argument = separator === -1 ? "" : input.slice(separator).trimStart();
    let command = this.#handlers.get(name);
    if (!command) {
      const original = /^(#(?:状态|统计))(机器人|用户|群|消息|日期)$/u.exec(name);
      if (original?.[1]) {
        const systemCommand = this.#handlers.get(original[1]);
        if (systemCommand?.names[0] === "@lotus-yunzai/system") {
          command = systemCommand;
          argument = `${original[2]} ${argument}`.trimEnd();
        }
      }
    }
    if (!command || (allowed && !allowed(command.names))) return;

    return forGameCommandSender(context.user_id, context.isDelegated, () => command.handler(argument, commandContext(context, command.names[0])));
  }

  async dispatchFallback(
    event: MessageEvent,
    allowed: (names: readonly string[]) => boolean,
    isBotMaster: MessageFallbackContext["isBotMaster"],
    normalizedMessage = event.msg,
    capabilities?: Pick<MessageFallbackContext,
      "configureNoticeSettings" | "groupOriginalSignal" | "characterGallerySignal" | "readCharacterGalleryImages" |
      "canManagePackages" | "panelTransfer" | "offerLegacyPanelRecovery" | "authorizeCheckinOwner">,
    onlyModule?: string,
  ): Promise<CommandReply | undefined> {
    const { offerLegacyPanelRecovery, authorizeCheckinOwner, ...sharedCapabilities } = capabilities ?? {};
    for (const { handler, names, features, trustedLegacyPanelRecovery } of this.#fallbacks.values()) {
      if (onlyModule !== undefined && names[0] !== onlyModule) continue;
      if (!features && !allowed(names)) continue;
      const context = {
        ...commandContext(event),
        ...(authorizeCheckinOwner && names[0] === "@lotus-yunzai/checkin-batch-refresh" ? { authorizeCheckinOwner } : {}),
        sender: event.sender, sub_type: event.sub_type, reply_id: event.reply_id, lookupReply: event.lookupReply,
        lookupMediaReply: names[0] === "@lotus-yunzai/genshin" ? event.lookupMediaReply : undefined,
        verifyOwnGroupMembership: names[0] === "@lotus-yunzai/genshin" && !event.isDelegated && !event.attachmentOnly
          ? event.verifyOwnGroupMembership : undefined,
        reply: event.reply, forward: event.forward, isBotMaster, normalizedMessage, ...sharedCapabilities,
        ...(trustedLegacyPanelRecovery && offerLegacyPanelRecovery && { offerLegacyPanelRecovery }),
        [ownerContactListSession]: names[0] === "@lotus-yunzai/panel-owner-session" ? event[ownerContactListSession] : undefined,
        [groupExportSession]: names[0] === "@lotus-yunzai/group-member-export" && !event.isDelegated ? event[groupExportSession] : undefined,
      };
      const reply = await forGameCommandSender(event.user_id, event.isDelegated, async () => {
        if (features && !allowed([...names, ...(await features(context))])) return;
        return handler(event.msg, context);
      });
      if (reply !== undefined) return reply;
    }
  }
}
