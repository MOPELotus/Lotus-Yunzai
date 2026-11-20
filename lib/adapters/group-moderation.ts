import { createHash } from "node:crypto";
import { maxChatFileBytes, readQqMessageSegmentMedia } from "../chat-files.ts";
import type { createGroupJoinReview, JoinRequestOrigin } from "../group-join-review.ts";
import type { GroupNotice, GroupRequest, InboundSegment, MessageEvent, MessageReply, ProtocolSegment } from "../messages.ts";
import type { NativeTemporaryMessageNotice } from "../temporary-message-notice.ts";
import type { NativeFriendRecallNotice, NativeGroupRecallNotice, NativeGroupRecallSource } from "../message-recall-notice.ts";

export type GroupModerationResult = "confirmed" | "rejected" | "unknown";
type GroupMemberModerationResult = GroupModerationResult | "protected" | "unavailable";
export type GroupMuteAction = (userId: number, seconds: number) => Promise<GroupMemberModerationResult>;
export type GroupMuteSelfAction = (seconds: number) => Promise<GroupMemberModerationResult>;
export type GroupWholeMuteAction = (enabled: boolean) => Promise<GroupModerationResult | "unavailable">;
export type GroupKickAction = (userId: number, block: boolean) => Promise<GroupMemberModerationResult>;
export type GroupManageBlacklistAction = () => Promise<boolean>;
export type GroupSpecialTitleAction = (
  userId: number, title: string, verify?: () => Promise<boolean>,
) => Promise<GroupMemberModerationResult>;
export type GroupSetAdminAction = (userId: number, enabled: boolean) => Promise<GroupMemberModerationResult>;
export type GroupSetQuotedEssenceAction = (
  enabled: boolean,
) => Promise<GroupModerationResult | "unavailable" | "invalid-quote">;
export type GroupNotifyAllAction = (
  parts: readonly InboundSegment[],
) => Promise<GroupModerationResult | "unavailable">;
export interface TimedGroupMuteBinding {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly groupId: number;
  readonly issuerId: number;
  readonly enabled: boolean;
}
export type TimedGroupMuteResult = GroupModerationResult | "unavailable";

export interface MutedGroupMember {
  readonly userId: number;
  readonly name?: string;
  readonly role?: Role;
  readonly until: number;
}

export interface GroupActivityMember {
  readonly userId: number;
  readonly name?: string;
  readonly role: Role;
  readonly joinTime: number;
  readonly lastSentTime: number;
}

export type GroupActivityVisibility = "management" | "member";

export function readGroupActivity(members: unknown, scope: {
  readonly group: number; readonly bot: number; readonly actor: number; readonly master: () => boolean;
  readonly count: number;
  readonly visibility?: GroupActivityVisibility;
}): readonly GroupActivityMember[] | undefined {
  if (!Array.isArray(members) || scope.count < 1 || scope.count > 10_000 || members.length !== scope.count) return;
  const roster = new Map<number, GroupActivityMember>();
  for (const row of members as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return;
    const { group_id, user_id, join_time, last_sent_time, role, card, nickname } = row as Record<string, unknown>;
    if (group_id !== scope.group || typeof user_id !== "number" || !Number.isSafeInteger(user_id) ||
        user_id <= 0 || roster.has(user_id) || (role !== "member" && role !== "admin" && role !== "owner") ||
        typeof join_time !== "number" || !Number.isSafeInteger(join_time) || join_time <= 0 || join_time > 8_640_000_000_000 ||
        typeof last_sent_time !== "number" || !Number.isSafeInteger(last_sent_time) || last_sent_time < 0 ||
        last_sent_time > 8_640_000_000_000) return;
    const name = (typeof card === "string" && card.trim()) || (typeof nickname === "string" && nickname.trim()) || undefined;
    roster.set(user_id, { userId: user_id, name, role, joinTime: join_time, lastSentTime: last_sent_time });
  }
  const actor = roster.get(scope.actor);
  if (actor && roster.has(scope.bot) &&
      (scope.visibility === "member" || actor.role !== "member" || scope.master())) return [...roster.values()];
}

export interface GroupActionPolicy {
  readonly canModerateGroups?: () => boolean;
  readonly canModeratePrivateGroup?: (bot: number, group: number) => boolean;
  readonly isProtectedMaster?: (bot: number, user: number) => boolean;
  readonly onMemberMute?: (notice: MemberMuteNotice) => void;
  readonly onTemporaryMessage?: (notice: NativeTemporaryMessageNotice) => void;
  readonly onFriendRecall?: (notice: NativeFriendRecallNotice) => void;
  readonly onGroupRecall?: (notice: NativeGroupRecallNotice) => void;
  readonly onGroupRecallSource?: (source: NativeGroupRecallSource) => void;
  readonly onGroupOwnerMemberNotice?: (notice: NativeGroupOwnerMemberNotice) => void;
  readonly onGroupOwnerAdminNotice?: (notice: NativeGroupOwnerAdminNotice) => void;
  readonly joinReview?: ReturnType<typeof createGroupJoinReview>;
  readonly groupWorkflowSignal?: () => AbortSignal;
}

interface GroupOwnerNoticeSession {
  readonly adapter: "onebot" | "milky";
  readonly signal: AbortSignal;
  notifyOwners(reply: MessageReply, signal: AbortSignal): Promise<number>;
}

export interface NativeGroupOwnerMemberNotice extends GroupOwnerNoticeSession {
  readonly event: GroupNotice;
  describe(signal: AbortSignal): Promise<{ groupName?: string; nickname?: string; card?: string }>;
}

export interface NativeGroupOwnerAdminNotice extends GroupOwnerNoticeSession {
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly set: boolean;
  readonly time: number;
}

export interface MemberMuteNotice {
  readonly self_id: number;
  readonly group_id: number;
  readonly user_id: number;
  readonly operator_id: number;
  readonly time: number;
  readonly duration: number;
  readonly signal: AbortSignal;
  canModerate(signal: AbortSignal): Promise<boolean>;
  unmute(signal: AbortSignal): Promise<GroupModerationResult>;
  reply(reply: MessageReply): Promise<boolean>;
}

export function isMemberMuteDuration(duration: unknown): duration is number {
  return typeof duration === "number" && Number.isInteger(duration) && duration >= 0 && duration <= 2_147_483_647;
}

type Role = "member" | "admin" | "owner";
export interface LiveGroupMember {
  readonly role: Role;
  readonly name?: string;
  readonly nickname?: string;
  readonly card?: string;
  readonly joinTime?: number;
  readonly lastSentTime?: number;
}

interface PrivateGroupMemberResult {
  readonly status: GroupModerationResult | "unavailable" | "protected";
  readonly memberName?: string;
}
export type PrivateGroupMute = (groupId: number, userId: number, seconds: number) => Promise<PrivateGroupMemberResult>;
export type PrivateGroupKick = (groupId: number, userId: number) => Promise<PrivateGroupMemberResult>;
export type PrivateGroupWholeMute = (groupId: number, enabled: boolean) => Promise<{
  readonly status: GroupModerationResult | "unavailable";
  readonly groupName?: string;
}>;

export function bindPrivateGroupActions({ bot, signal, master, protectedMember, allowed, member, mute, wholeMute, groupName, kick }: {
  bot: number;
  signal: AbortSignal;
  master: () => boolean;
  protectedMember: (user: number) => boolean;
  allowed: (group: number) => boolean;
  member: (group: number, user: number, signal: AbortSignal) => Promise<LiveGroupMember | undefined>;
  mute: (group: number, user: number, seconds: number, signal: AbortSignal) => Promise<GroupModerationResult>;
  wholeMute: (group: number, enabled: boolean, signal: AbortSignal) => Promise<GroupModerationResult>;
  groupName: (group: number, signal: AbortSignal) => Promise<string | undefined>;
  kick: (group: number, user: number, signal: AbortSignal) => Promise<GroupModerationResult>;
}): { privateGroupMute: PrivateGroupMute; privateGroupWholeMute: PrivateGroupWholeMute; privateGroupKick: PrivateGroupKick } {
  const active = (group: number) => !signal.aborted && master() && allowed(group);
  async function moderateMember(group: number, user: number, protectMaster: boolean, perform: () => Promise<GroupModerationResult>): Promise<PrivateGroupMemberResult> {
    if (!Number.isSafeInteger(group) || group <= 0 || !Number.isSafeInteger(user) || user <= 0) {
      return { status: "rejected" };
    }
    const protectedTarget = () => user === bot || protectMaster && protectedMember(user);
    if (!active(group)) return { status: "unavailable" };
    if (protectedTarget()) return { status: "protected" };
    const [botState, target] = await Promise.all([member(group, bot, signal), member(group, user, signal)]).catch(() => []);
    if (!active(group) || !botState || botState.role === "member" || !target) return { status: "unavailable" };
    if (protectedTarget() || target.role === "owner" || (target.role === "admin" && botState.role !== "owner")) return { status: "protected" };
    try { return { status: await perform(), memberName: target.name }; }
    catch { return { status: "unknown" }; }
  }
  const privateGroupMute: PrivateGroupMute = async (group, user, seconds) => {
    if (!isMemberMuteDuration(seconds)) return { status: "rejected" };
    return moderateMember(group, user, seconds > 0, () => mute(group, user, seconds, signal));
  };
  const privateGroupKick: PrivateGroupKick = (group, user) => moderateMember(group, user, true, () => kick(group, user, signal));
  const privateGroupWholeMute: PrivateGroupWholeMute = async (group, enabled) => {
    if (!Number.isSafeInteger(group) || group <= 0 || typeof enabled !== "boolean") return { status: "rejected" };
    if (!active(group)) return { status: "unavailable" };
    const botState = await member(group, bot, signal).catch(() => undefined);
    if (!active(group) || !botState || botState.role === "member") return { status: "unavailable" };
    const status = await wholeMute(group, enabled, signal).catch(() => "unknown" as const);
    const name = status === "confirmed" && active(group) ? await groupName(group, signal).catch(() => undefined) : undefined;
    return { status, groupName: name };
  };
  return { privateGroupMute, privateGroupWholeMute, privateGroupKick };
}

export interface GroupVerificationScope {
  readonly connection: AbortSignal;
  readonly signal: AbortSignal;
  canConfigure(): Promise<boolean>;
  prepare(target: number, expected?: { readonly joinTime: number; readonly lastSentTime: number }): Promise<GroupVerificationSubject | undefined>;
}

interface GroupVerificationTransport {
  readonly adapter: "onebot" | "milky";
  member(user: number, signal: AbortSignal): Promise<LiveGroupMember | undefined>;
  send(reply: MessageReply, signal: AbortSignal): Promise<boolean>;
}

interface GroupVerificationSubject {
  readonly adapter: GroupVerificationTransport["adapter"];
  readonly botId: number;
  readonly groupId: number;
  readonly userId: number;
  readonly time: number;
  readonly inviterId?: number;
  readonly connection: AbortSignal;
  readonly signal: AbortSignal;
  inspect(): Promise<{ readonly botRole: Role; readonly targetRole: Role; readonly targetJoinTime?: number;
    readonly inviterRole?: Role; readonly protectedTarget: boolean } | undefined>;
  reply(parts: MessageReply): Promise<boolean>;
  kick(signal: AbortSignal, expectedJoinTime?: number): Promise<GroupModerationResult | "unavailable" | "protected">;
}

async function groupOwnerCanConfigure(active: () => boolean, isMaster: () => boolean, role: () => Promise<Role | undefined>) {
  return active() && isMaster() && !!await role().catch(() => undefined) && active() && isMaster();
}

export function bindGroupVerificationScope({ connection, workflow, accepting, isMaster, isProtected, transport, botId, groupId,
  actorId, kick }: {
  connection: AbortSignal;
  workflow: AbortSignal;
  accepting: () => boolean;
  isMaster: () => boolean;
  isProtected: (user: number) => boolean;
  transport: GroupVerificationTransport;
  botId: number;
  groupId: number;
  actorId: number;
  kick: (user: number, signal: AbortSignal) => Promise<GroupModerationResult>;
}): GroupVerificationScope {
  const signal = AbortSignal.any([connection, workflow]);
  const active = () => !signal.aborted && actorId !== botId && accepting();
  return { connection, signal,
    canConfigure: () => groupOwnerCanConfigure(active, isMaster, async () => (await transport.member(actorId, signal))?.role),
    async prepare(userId, expected) {
      if (!active() || !Number.isSafeInteger(userId) || userId <= 0 || userId === botId) return;
      return bindGroupVerificationSubject({ botId, groupId, userId, time: Math.floor(Date.now() / 1000), connection, signal, active,
        isProtected: () => isProtected(userId), transport, actor: { id: actorId, isMaster }, expected, kick: running => kick(userId, running) });
    },
  };
}

export function bindGroupVerificationSubject({ botId, groupId, userId, time, inviterId, connection, signal, active, isProtected,
  transport, actor, expected, kick }: {
  botId: number; groupId: number; userId: number; time: number; inviterId?: number;
  connection: AbortSignal; signal: AbortSignal; active: () => boolean; isProtected: () => boolean;
  transport: GroupVerificationTransport;
  actor?: { id: number; isMaster: () => boolean };
  expected?: { readonly joinTime: number; readonly lastSentTime: number };
  kick: (signal: AbortSignal) => Promise<GroupModerationResult>;
}): GroupVerificationSubject {
  let expectedBeforePrompt = expected;
  async function readRoles(running: AbortSignal, readInviter = false) {
    if (!active() || running.aborted) return;
    const [bot, member, inviter, issuer] = await Promise.all([transport.member(botId, running), transport.member(userId, running),
      readInviter && inviterId && inviterId !== userId ? transport.member(inviterId, running) : undefined,
      actor && transport.member(actor.id, running)]);
    if (!active() || running.aborted || !bot || !member ||
        (actor && (!issuer || (issuer.role === "member" && !actor.isMaster())))) return;
    if (expectedBeforePrompt && (member.joinTime !== expectedBeforePrompt.joinTime || member.lastSentTime !== expectedBeforePrompt.lastSentTime)) return;
    return { bot, member, inviter };
  }

  return {
    adapter: transport.adapter, botId, groupId, userId, time, inviterId, connection, signal,
    async inspect() {
      const roles = await readRoles(signal, true);
      if (roles) return { botRole: roles.bot.role, targetRole: roles.member.role, targetJoinTime: roles.member.joinTime,
        inviterRole: roles.inviter?.role, protectedTarget: isProtected() };
    },
    async reply(parts) {
      if (!active()) return false;
      if (expectedBeforePrompt) {
        const roles = await readRoles(signal);
        if (!roles || roles.bot.role === "member" || roles.member.role !== "member" || isProtected()) return false;
      }
      if (!active() || !await transport.send(parts, signal) || !active()) return false;
      expectedBeforePrompt = undefined;
      return true;
    },
    async kick(request, expectedJoinTime) {
      const running = AbortSignal.any([request, signal]);
      const roles = await readRoles(running);
      if (!roles || roles.bot.role === "member" || (expectedJoinTime !== undefined && roles.member.joinTime !== expectedJoinTime)) {
        return "unavailable";
      }
      if (isProtected() || roles.member.role !== "member") return "protected";
      return kick(running);
    },
  };
}

type GroupVoteReply = readonly (string | { readonly type: "at"; readonly qq: number })[];

export interface GroupVoteAccess {
  readonly connection: AbortSignal;
  readonly signal: AbortSignal;
  inspect(target: number): Promise<{ readonly actor: Role; readonly bot: Role; readonly target: Role;
    readonly protectedTarget: boolean } | undefined>;
  execute(target: number, action: "mute" | "kick", seconds: number, allowAdmin: boolean,
    requireActorAdmin?: boolean): Promise<GroupModerationResult | "unavailable" | "protected">;
  canConfigure(): Promise<boolean>;
  reply(parts: GroupVoteReply, quote?: boolean): Promise<boolean>;
}

export interface GroupAnnouncement {
  readonly id: string;
  readonly text: string;
}

export type GroupPublishAnnouncement = (text: string) => Promise<GroupModerationResult | "unavailable" | "invalid-image">;
export type GroupDeleteAnnouncement = (index: number) => Promise<{
  readonly status: GroupModerationResult | "unavailable" | "not-found";
  readonly text?: string;
}>;

export function readGroupAnnouncements(rows: unknown, decode: (row: unknown) => GroupAnnouncement | null | undefined) {
  if (!Array.isArray(rows)) return;
  const entries: GroupAnnouncement[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const entry = decode(row);
    if (entry === null) continue;
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id) || typeof entry.text !== "string") return;
    entries.push(entry);
    ids.add(entry.id);
  }
  return entries;
}

export async function groupMayReadPendingJoins(
  role: (id: number) => Promise<Role | undefined>, bot: number, actor: number, active: () => boolean,
): Promise<boolean> {
  if (!active() || actor === bot) return false;
  const [botRole, actorRole] = await Promise.all([role(bot), role(actor)]).catch(() => []);
  return active() && !!actorRole && (botRole === "admin" || botRole === "owner");
}

export async function groupOperatorAuthority(
  role: (id: number) => Promise<Role | undefined>, bot: number, actor: number, isMaster: () => boolean, active: () => boolean,
) {
  const [actorRole, botRole] = await Promise.all([role(actor), role(bot)]).catch(() => []);
  if (!active() || !actorRole || !botRole) return;
  const master = isMaster();
  if ((master || actorRole !== "member") && botRole !== "member") return { master, botRole };
}

export async function runTimedWholeMute(binding: TimedGroupMuteBinding, session: {
  role(userId: number): Promise<Role | undefined>;
  isMaster(): boolean;
  active(): boolean;
  write(enabled: boolean): Promise<GroupModerationResult>;
}): Promise<TimedGroupMuteResult> {
  const { botId, groupId, issuerId, enabled } = binding;
  if (![botId, groupId, issuerId].every(id => Number.isSafeInteger(id) && id > 0) || typeof enabled !== "boolean") return "rejected";
  if (!session.active() || !await groupOperatorAuthority(session.role, botId, issuerId, session.isMaster, session.active) ||
      !session.active()) return "unavailable";
  try { return await session.write(enabled); } catch { return "unknown"; }
}

const noticeMedia = new Set(["image", "record", "video"]);

function readGroupImageDigest(image: InboundSegment) {
  return async (signal: AbortSignal) => {
    const bytes = await readQqMessageSegmentMedia(image, signal);
    if (bytes && !signal.aborted) return createHash("md5").update(bytes).digest("hex");
  };
}

export function bindSingleGroupImageDigest(source: MessageEvent["message"]) {
  if (typeof source === "string") return;
  const content = source.filter(part => part.type !== "text" || typeof part.text !== "string" || part.text.trim());
  const image = content.length === 1 && content[0]?.type === "image" ? content[0] : undefined;
  if (image) return readGroupImageDigest(image);
}

export type GroupImageRulePart = { readonly type: "text"; readonly text: string } |
  { readonly type: "face"; readonly id: number } |
  { readonly type: "image"; readonly readMd5: (signal: AbortSignal) => Promise<string | undefined> };

export function bindMixedGroupImageParts(source: MessageEvent["message"]): readonly GroupImageRulePart[] | undefined {
  if (typeof source === "string" || !source.some(part => part.type === "image")) return;
  const parts: GroupImageRulePart[] = [];
  let images = 0;
  for (const part of source) {
    if (part.type === "text" && typeof part.text === "string") {
      const previous = parts.at(-1);
      if (previous?.type === "text") parts[parts.length - 1] = { type: "text", text: previous.text + part.text };
      else parts.push({ type: "text", text: part.text });
    } else if (part.type === "face") {
      const id = typeof part.id === "string" && /^(?:0|[1-9]\d*)$/u.test(part.id) ? Number(part.id) : part.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return;
      parts.push({ type: "face", id });
    } else if (part.type === "image") {
      if (++images > 3) return;
      parts.push({ type: "image", readMd5: readGroupImageDigest(part) });
    } else return;
  }
  if (images > 1 || parts.some(part => part.type === "face" || part.type === "text" && part.text.trim())) return parts;
}

export function bindGroupRuleImageDigest(source: MessageEvent["message"], bot: number, session: AbortSignal,
  accepting: (() => boolean) | undefined, role: (signal: AbortSignal) => Promise<Role | undefined>) {
  if (typeof source === "string") return;
  const digest = bindSingleGroupImageDigest(source.filter(part => part.type !== "text" &&
    !(part.type === "at" && String(part.qq) === String(bot))));
  if (!digest) return;
  return async (request: AbortSignal) => {
    const signal = AbortSignal.any([session, request]);
    const active = () => !signal.aborted && accepting?.() !== false;
    if (!active() || !await role(signal) || !active()) return;
    const md5 = await digest(signal).catch(() => undefined);
    if (md5 && active() && await role(signal) && active()) return md5;
  };
}

async function buildGroupNotice(parts: readonly InboundSegment[], source: MessageEvent["message"], signal: AbortSignal) {
  if (!Array.isArray(parts) || !parts.length) return;
  let mediaBytes = 0;
  const reply: ProtocolSegment[] = [{ type: "at", data: { qq: "all" } }];
  for (const part of parts) {
    if (signal.aborted || !part || typeof part.type !== "string") return;
    const { type } = part;
    if (type === "text" && typeof part.text === "string") {
      reply.push({ type, data: { text: part.text } });
    } else if (type === "at" && part.qq === "all") {
      continue;
    } else if (type === "at" && (typeof part.qq === "string" || typeof part.qq === "number") && /^[1-9]\d*$/u.test(String(part.qq))) {
      reply.push({ type, data: { qq: String(part.qq) } });
    } else if (type === "face" && (typeof part.id === "string" || typeof part.id === "number") && /^\d+$/u.test(String(part.id))) {
      reply.push({ type, data: { id: String(part.id), ...(part.is_large === true && { is_large: true }) } });
    } else if ((type === "image" || type === "record" || type === "video") &&
        typeof source !== "string" && source.includes(part)) {
      const bytes = await readQqMessageSegmentMedia(part, signal);
      if (!bytes || (mediaBytes += bytes.byteLength) > maxChatFileBytes) return;
      reply.push({ type, data: { file: bytes,
        ...(type === "image" && typeof part.summary === "string" && { summary: part.summary }) } });
    } else return;
  }
  if (!signal.aborted && reply.slice(1).some(({ type, data }) => type !== "text" ||
      (typeof data.text === "string" && data.text.trim()))) return reply;
}

export function bindMessageGroupActions({ bot, actor, signal, accepting, isMaster, isProtected, role, mute, wholeMute, kick, title, setAdmin,
  essence, notice, announcement, vote }: {
  readonly bot: number;
  readonly actor: number;
  readonly signal: AbortSignal;
  readonly accepting?: () => boolean;
  readonly isMaster: () => boolean;
  readonly isProtected: (userId: number) => boolean;
  readonly role: (userId: number) => Promise<Role | undefined>;
  readonly mute: (userId: number, seconds: number, active?: AbortSignal) => Promise<GroupModerationResult>;
  readonly wholeMute: (enabled: boolean) => Promise<GroupModerationResult>;
  readonly kick: (userId: number, block: boolean, active?: AbortSignal) => Promise<GroupModerationResult>;
  readonly title: (userId: number, text: string) => Promise<GroupModerationResult>;
  readonly setAdmin: (userId: number, enabled: boolean) => Promise<GroupModerationResult>;
  readonly essence?: {
    verifyQuote(): Promise<boolean>;
    write(enabled: boolean): Promise<GroupModerationResult>;
  };
  readonly notice?: {
    readonly source: MessageEvent["message"];
    send(reply: MessageReply): Promise<GroupModerationResult>;
  };
  readonly announcement?: {
    readonly source: MessageEvent["message"];
    available?(): Promise<boolean>;
    list(): Promise<readonly GroupAnnouncement[] | undefined>;
    send(text: string, image?: string): Promise<GroupModerationResult>;
    remove(id: string): Promise<GroupModerationResult>;
    readonly confirmRemovalByList?: boolean;
  };
  readonly vote?: {
    readonly signal: AbortSignal;
    reply(parts: GroupVoteReply, quote: boolean | undefined, signal: AbortSignal): Promise<boolean>;
  };
}): {
  groupMute: GroupMuteAction; groupWholeMute: GroupWholeMuteAction; groupKick: GroupKickAction;
  groupManageBlacklist: GroupManageBlacklistAction; groupManageWhitelistAutoUnmute: GroupManageBlacklistAction;
  groupSetSpecialTitle: GroupSpecialTitleAction;
  groupSetAdmin: GroupSetAdminAction;
  groupSetQuotedEssence?: GroupSetQuotedEssenceAction;
  groupMuteSelf: GroupMuteSelfAction;
  groupNotifyAll?: GroupNotifyAllAction;
  groupPublishAnnouncement?: GroupPublishAnnouncement;
  groupDeleteAnnouncement?: GroupDeleteAnnouncement;
  groupVote?: GroupVoteAccess;
} {
  const active = () => !signal.aborted && accepting?.() !== false;
  async function authorize() {
    return await groupOperatorAuthority(role, bot, actor, isMaster, active) ?? "unavailable" as const;
  }

  async function apply(write: () => Promise<GroupModerationResult>): Promise<GroupModerationResult | "unavailable"> {
    if (!active()) return "unavailable";
    try {
      return await write();
    } catch {
      return "unknown";
    }
  }

  async function protectedTarget(userId: number, protectMasters: boolean) {
    if (!Number.isSafeInteger(userId) || userId <= 0) return "rejected" as const;
    const authority = await authorize();
    if (typeof authority === "string") return authority;
    const target = await role(userId).catch(() => undefined);
    if (!active() || !target) return "unavailable" as const;
    if (userId === bot || target === "owner" || (protectMasters && isProtected(userId)) ||
        (target === "admin" && (authority.botRole !== "owner" || !authority.master))) return "protected" as const;
  }

  async function canManage(param: "list" | "automatic") {
    if (!active()) return false;
    const authority = await authorize();
    return typeof authority !== "string" && (param === "list" || authority.master) && active();
  }

  async function groupOwnerTarget(userId: number, needsMaster: boolean) {
    if (!active() || (needsMaster && !isMaster())) return "unavailable" as const;
    if (userId === bot) return "protected" as const;
    const [actorRole, botRole, otherRole] = await Promise.all([role(actor), role(bot), userId === actor ? undefined : role(userId)])
      .catch(() => []);
    const targetRole = userId === actor ? actorRole : otherRole;
    if (!active() || !actorRole || !targetRole || botRole !== "owner" || (needsMaster && !isMaster())) return "unavailable" as const;
    return targetRole === "owner" ? "protected" as const : targetRole;
  }

  function bindVote(access: NonNullable<typeof vote>): GroupVoteAccess {
    const voteSignal = AbortSignal.any([signal, access.signal]);
    const voting = () => actor !== bot && !voteSignal.aborted && active();
    const protectedVoteTarget = (target: number) => target === actor || target === bot || isProtected(target);
    return {
      connection: signal,
      signal: voteSignal,
      async inspect(target) {
        if (!voting() || !Number.isSafeInteger(target) || target < 1) return;
        const [actorRole, botRole, targetRole] = await Promise.all([role(actor), role(bot), role(target)]).catch(() => []);
        if (!voting() || !actorRole || !botRole || !targetRole) return;
        return { actor: actorRole, bot: botRole, target: targetRole, protectedTarget: protectedVoteTarget(target) };
      },
      async execute(target, action, seconds, allowAdmin, requireActorAdmin) {
        if (!Number.isSafeInteger(target) || target < 1 || (action !== "mute" && action !== "kick") ||
            (action === "mute" && (!isMemberMuteDuration(seconds) || !seconds))) return "rejected";
        if (!voting()) return "unavailable";
        if (protectedVoteTarget(target)) return "protected";
        const [botRole, targetRole, actorRole] = await Promise.all([role(bot), role(target),
          requireActorAdmin ? role(actor) : undefined]).catch(() => []);
        if (!voting() || !botRole || botRole === "member" || !targetRole ||
            (requireActorAdmin && actorRole !== "owner" && actorRole !== "admin")) return "unavailable";
        if (protectedVoteTarget(target) || targetRole === "owner" || (targetRole === "admin" && (!allowAdmin || botRole !== "owner"))) {
          return "protected";
        }
        return apply(() => action === "mute" ? mute(target, seconds, voteSignal) : kick(target, false, voteSignal));
      },
      canConfigure: () => groupOwnerCanConfigure(voting, isMaster, () => role(actor)),
      async reply(parts, quote) {
        return voting() && await access.reply(parts, quote, voteSignal).catch(() => false) && voting();
      },
    };
  }

  return {
    async groupMute(userId, seconds) {
      if (!active()) return "unavailable";
      if (!isMemberMuteDuration(seconds)) return "rejected";
      return await protectedTarget(userId, seconds > 0) ?? apply(() => mute(userId, seconds));
    },
    async groupWholeMute(enabled) {
      if (!active()) return "unavailable";
      if (typeof enabled !== "boolean") return "rejected";
      const authority = await authorize();
      if (typeof authority === "string") return authority;
      return apply(() => wholeMute(enabled));
    },
    async groupKick(userId, block) {
      if (!active()) return "unavailable";
      if (typeof block !== "boolean") return "rejected";
      return await protectedTarget(userId, true) ?? apply(() => kick(userId, block));
    },
    groupManageBlacklist: () => canManage("list"),
    groupManageWhitelistAutoUnmute: () => canManage("automatic"),
    async groupSetSpecialTitle(userId, text, verify) {
      if (!Number.isSafeInteger(userId) || userId <= 0 || typeof text !== "string") return "rejected";
      const target = await groupOwnerTarget(userId, userId !== actor);
      if (target === "unavailable" || target === "protected") return target;
      if (verify) {
        const permitted = await verify().catch(() => undefined);
        if (permitted === undefined) return "unavailable";
        if (!permitted) return "protected";
      }
      if (userId !== actor && !isMaster()) return "unavailable";
      return apply(() => title(userId, text));
    },
    async groupSetAdmin(userId, enabled) {
      if (!Number.isSafeInteger(userId) || userId <= 0 || typeof enabled !== "boolean") return "rejected";
      const target = await groupOwnerTarget(userId, true);
      if (target === "unavailable" || target === "protected") return target;
      if (!isMaster() || !active()) return "unavailable";
      if ((target === "admin") === enabled) return "confirmed";
      return apply(() => setAdmin(userId, enabled));
    },
    groupSetQuotedEssence: essence ? async enabled => {
      if (typeof enabled !== "boolean") return "rejected";
      if (!await canManage("list")) return "unavailable";
      if (!await essence.verifyQuote().catch(() => false)) return "invalid-quote";
      if (!await canManage("list")) return "unavailable";
      return apply(() => essence.write(enabled));
    } : undefined,
    async groupMuteSelf(seconds) {
      if (!active()) return "unavailable";
      if (!isMemberMuteDuration(seconds) || seconds === 0) return "rejected";
      if (actor === bot || isProtected(actor)) return "protected";
      const [actorRole, botRole] = await Promise.all([role(actor), role(bot)]).catch(() => []);
      if (!active() || !actorRole || !botRole || botRole === "member") return "unavailable";
      if (isProtected(actor) || actorRole === "owner" || (actorRole === "admin" && botRole !== "owner")) return "protected";
      return apply(() => mute(actor, seconds));
    },
    groupNotifyAll: notice ? async parts => {
      if (!await canManage("list")) return "unavailable";
      const reply = await buildGroupNotice(parts, notice.source, signal).catch(() => undefined);
      if (!reply) return "rejected";
      if (parts.some(({ type }) => noticeMedia.has(type)) && !await canManage("list")) return "unavailable";
      return apply(() => notice.send(reply));
    } : undefined,
    groupPublishAnnouncement: announcement ? async text => {
      if (typeof text !== "string" || !text.trim()) return "rejected";
      if (!await canManage("list") || announcement.available && !await announcement.available() || !active()) return "unavailable";
      const image = typeof announcement.source === "string" ? undefined : announcement.source.find(part => part.type === "image");
      const bytes = image && await readQqMessageSegmentMedia(image, signal).catch(() => undefined);
      if (!active()) return "unavailable";
      if (image && !bytes) return "invalid-image";
      if ((announcement.available || image) && !await canManage("list")) return "unavailable";
      return apply(() => announcement.send(text, bytes && `base64://${Buffer.from(bytes).toString("base64")}`));
    } : undefined,
    groupDeleteAnnouncement: announcement ? async index => {
      if (!Number.isSafeInteger(index) || index < 1) return { status: "not-found" };
      if (!await canManage("list")) return { status: "unavailable" };
      const before = await announcement.list().catch(() => undefined);
      if (!before || !active()) return { status: "unavailable" };
      const selected = before[index - 1];
      if (!selected) return { status: "not-found" };
      if (!await canManage("list")) return { status: "unavailable" };
      const status = await apply(() => announcement.remove(selected.id));
      if (status !== "confirmed") return { status };
      if (announcement.confirmRemovalByList) {
        const after = active() ? await announcement.list().catch(() => undefined) : undefined;
        const remainder = before.filter(entry => entry.id !== selected.id);
        if (!after || !active() || after.length !== remainder.length || !after.every((entry, i) => entry.id === remainder[i]?.id)) {
          return { status: "unknown" };
        }
      }
      return { status: "confirmed", text: selected.text };
    } : undefined,
    groupVote: vote && bindVote(vote),
  };
}

interface GroupModerationSession {
  readonly signal: AbortSignal;
  readonly joinRequestOrigin?: JoinRequestOrigin;
  readonly groupVerification?: GroupVerificationTransport;
  readonly act?: (signal: AbortSignal, reason?: string) => Promise<GroupModerationResult>;
  readonly canModerate?: (signal: AbortSignal) => Promise<boolean>;
  readonly memberMessage?: {
    readImageMd5?(signal: AbortSignal): Promise<string | undefined>;
    readonly mixedImageParts?: readonly GroupImageRulePart[];
    canAct(signal: AbortSignal): Promise<boolean>;
    botCanAct(signal: AbortSignal): Promise<boolean>;
    mute(seconds: number, signal: AbortSignal): Promise<GroupModerationResult>;
    recall(signal: AbortSignal): Promise<GroupModerationResult>;
    send?(reply: MessageReply, signal: AbortSignal): Promise<boolean>;
  };
}

type GroupModerationEvent = GroupNotice | GroupRequest | MessageEvent;
const sessions = new WeakMap<GroupModerationEvent, GroupModerationSession>();

export function bindGroupModeration(event: GroupModerationEvent, session: GroupModerationSession): void {
  if (!session.signal.aborted) sessions.set(event, session);
}

export function groupModerationSession(event: GroupModerationEvent) {
  const session = sessions.get(event);
  return session?.signal.aborted === false ? session : undefined;
}

export async function canModerateGroupSubject(
  role: (userId: number) => Promise<Role | undefined>, bot: number, subject?: number, permitAdmin = true,
) {
  if (bot === subject) return false;
  const [botRole, subjectRole] = await Promise.all([role(bot), subject === undefined ? undefined : role(subject)]);
  return (botRole === "owner" || botRole === "admin") &&
    (subject === undefined || subjectRole === "member" || (permitAdmin && botRole === "owner" && subjectRole === "admin"));
}
