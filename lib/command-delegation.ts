import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { ExecuteContext, ExecuteRequest, ExecuteService, ExecuteTarget } from "../plugins/execute/index.ts";
import { legacyGroupMemberRoster, type MemberRosterEntry } from "./adapters/onebot-member-display.ts";
import type { ChatFileResult } from "./chat-files.ts";
import type { GroupMembership, MessageEvent, MessageReply } from "./messages.ts";

export const delegationSession = Symbol("delegationSession");
export interface DelegationSession {
  readonly signal: AbortSignal;
  readonly groups: () => Promise<readonly number[]>;
  readonly members: (groupId: number) => Promise<readonly number[]>;
  readonly readRoster?: (groupId: number, signal: AbortSignal) => Promise<readonly MemberRosterEntry[] | undefined>;
  readonly isFriend: (userId: number) => Promise<boolean>;
  readonly memberRole: (groupId: number, userId: number) => Promise<GroupMembership["botRole"] | undefined>;
  readonly botMute: (groupId: number) => Promise<MessageEvent["botMute"]>;
  readonly send: (target: ExecuteTarget, reply: MessageReply) => Promise<ChatFileResult>;
}

interface Binding {
  readonly origin: MessageEvent;
  readonly session: DelegationSession;
  plan?: { readonly request: ExecuteRequest; readonly targets: Set<string> };
}

function targetKey({ groupId, userId }: ExecuteTarget) { return `${groupId ?? "private"}:${userId}`; }

export function createCommandDelegation({ signal, mayDelegate, isMaster, run }: {
  readonly signal: AbortSignal;
  readonly mayDelegate: (event: MessageEvent) => boolean;
  readonly isMaster: (botId: number, userId: number) => boolean;
  readonly run: (event: MessageEvent, handled: () => void) => Promise<void>;
}) {
  const active = new WeakMap<AbortSignal, Binding>();

  function current(actor: ExecuteContext, cancellation: AbortSignal) {
    const key = actor.delegationSignal;
    const binding = key && active.get(key);
    if (cancellation.aborted || signal.aborted || key?.aborted || !binding || binding.session.signal.aborted ||
        actor.self_id !== binding.origin.self_id || actor.user_id !== binding.origin.user_id || actor.adapter !== binding.origin.adapter ||
        actor.group_id !== binding.origin.group_id || actor.message_type !== binding.origin.message_type || !mayDelegate(binding.origin)) return;
    return binding;
  }

  const execute: ExecuteService = {
    async resolveTargets(actor, request, cancellation) {
      const binding = current(actor, cancellation);
      if (!binding) return [];
      const { origin, session } = binding;
      const { group, users } = request;
      const known = group === "全部群" || typeof group === "number" ? await session.groups() : [];
      if (!current(actor, cancellation)) return [];
      const groups = group === "全部群" ? [...new Set(known)]
        : typeof group === "number" ? (known.includes(group) ? [group] : [])
          : [group === "本群" ? origin.group_id : undefined];
      const result: ExecuteTarget[] = [];
      for (const groupId of groups) {
        const members = users !== "all" ? users : groupId ? await session.members(groupId) : [];
        if (!current(actor, cancellation)) return [];
        for (const userId of new Set(members)) {
          if (!Number.isSafeInteger(userId) || userId < 1 || userId === origin.self_id) continue;
          if (result.length >= 10_000) throw new Error($t("lib.command-delegation.text_1f2b5a5b70"));
          result.push({ userId, groupId });
        }
      }
      binding.plan = { request, targets: new Set(result.map(targetKey)) };
      return result;
    },
    async dispatch(actor, target, request, cancellation) {
      const binding = current(actor, cancellation);
      if (!binding || !actor.self_id || binding.plan?.request !== request || !binding.plan.targets.delete(targetKey(target))) return "rejected";
      const { session, origin } = binding;
      const { groupId, userId } = target;
      const role = groupId === undefined ? undefined : await session.memberRole(groupId, userId);
      const eligible = groupId === undefined ? await session.isFriend(userId) : role !== undefined;
      if (!eligible || !current(actor, cancellation)) return "rejected";
      const botMute = groupId === undefined ? undefined : await session.botMute(groupId);
      if (!current(actor, cancellation)) return "rejected";
      const isGroup = groupId !== undefined;
      const message = request.segments.filter(segment => segment.type !== "file" && segment.type !== "reply");
      let match = false, dispatching = true;
      const delegated: MessageEvent = {
        msg: request.command, raw_message: request.command, message, adapter: origin.adapter, inlineImageByteLimit: origin.inlineImageByteLimit,
        self_id: actor.self_id, user_id: userId, group_id: groupId,
        post_type: "message", message_type: isGroup ? "group" : "private", sub_type: isGroup ? "normal" : "friend",
        isGroup, isPrivate: !isGroup, isMaster: isMaster(actor.self_id, userId),
        atBot: true, isDelegated: true, boundAccount: false, botMute, delegationSignal: cancellation,
        isFriend: () => session.isFriend(userId),
        ...(groupId !== undefined && session.readRoster && {
          async [legacyGroupMemberRoster]() {
            if (!dispatching || !current(actor, cancellation)) return;
            const roster = await session.readRoster?.(groupId, cancellation);
            if (dispatching && current(actor, cancellation) && roster?.some(member => member.id === userId)) return roster;
          },
        }),
        ...(role && { member: { is_admin: role === "admin", is_owner: role === "owner" } }),
        sender: { user_id: userId, ...(role && { role }) },
        async reply(content) {
          if (!dispatching || !current(actor, cancellation)) return false;
          match = true;
          if (request.hold) return true;
          return await session.send(target, content) !== "rejected";
        },
      };
      try {
        await run(delegated, () => { match = true; });
      } finally {
        dispatching = false;
      }
      return match ? "handled" : "rejected";
    },
  };

  return {
    execute,
    authorize(event: MessageEvent) {
      const session = event[delegationSession];
      if (signal.aborted || event.isDelegated || !session || session.signal.aborted || !mayDelegate(event)) return;
      const scope = new AbortController();
      const delegationSignal = AbortSignal.any([scope.signal, session.signal, signal]);
      active.set(delegationSignal, { origin: event, session });
      return {
        event: { ...event, canDelegate: true, delegationSignal },
        close() { active.delete(delegationSignal); scope.abort(); },
      };
    },
  };
}
