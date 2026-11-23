import { decodeChatFileBytes, maxChatFileBytes, readQqMessageMedia } from "./chat-files.ts";
import { delegationSession } from "./command-delegation.ts";
import { isMilkyOwnerSession } from "./command-permissions.ts";
import { isKeywordMedia } from "./keyword-store.ts";
import type { GroupMembership, InboundSegment, MessageEvent, MessageReply } from "./messages.ts";

type Scope = number | "global";
type Variants = readonly (readonly InboundSegment[])[];
type GroupRole = GroupMembership["botRole"];

interface KeywordStore {
  read(scope: Scope): Promise<ReadonlyMap<string, Variants>>;
  append(scope: Scope, key: string, segments: readonly InboundSegment[], signal?: AbortSignal): Promise<number>;
  remove(scope: Scope, key: string, index?: number): Promise<boolean>;
  render(segments: readonly InboundSegment[]): Promise<MessageReply | undefined>;
}

interface Settings {
  readonly addLimit: 0 | 1 | 2;
  readonly addPrivate: boolean;
  readonly addReply: boolean;
  readonly addAt: boolean;
  readonly addRecall: number;
}

interface Draft {
  readonly expires: number;
  readonly scope: Scope;
  readonly name: string;
  readonly segments: (InboundSegment | undefined)[];
  readonly signal?: AbortSignal;
  readonly legacyGroup?: number;
  readonly controller: AbortController;
  readonly active: AbortSignal;
  pending?: Promise<void>;
  bytes: number;
  omitted: number;
}

interface RecentGroupStore {
  read(actor: string): Promise<number | undefined>;
  write(actor: string, id: number): Promise<void>;
  readonly legacy?: {
    read(user: number): Promise<number | undefined>;
    allows(event: MessageEvent, id: number): boolean;
  };
}

const pageSize = 100;
const draftTtl = 120_000;
const recentGroupTtl = 30 * 24 * 60 * 60_000;
const maxDrafts = 1024;
const maxRecentGroups = 4096;
const maxDraftSegments = 1000;
const maxMediaDownloads = 4;
const maxDraftMediaBytes = maxMediaDownloads * maxChatFileBytes;
const finishCommand = "#结束添加";
const managementCommand = /^#(全局)?(添加|删除|消息|词条)([\s\S]*)$/u;
const compatibilityDirectory = /^#(全局表情|合并词条)([\s\S]*)$/u;
const unboundMessage = "请通过已绑定的机器人连接管理词条。";

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function identity(event: MessageEvent) {
  const { self_id: bot, user_id: user } = event;
  if (!isId(bot) || !isId(user) || bot === user) return;
  const actor = event.adapter === "milky" ? `milky:${bot}:${user}` : `${bot}:${user}`;
  if (event.message_type === "private") return { actor, chat: `${actor}:private` };
  if (event.message_type === "group" && isId(event.group_id)) {
    return { actor, chat: `${actor}:group:${event.group_id}`, group: event.group_id };
  }
}

function hasKeywordSession(event: MessageEvent): boolean {
  const signal = event[delegationSession]?.signal;
  return !event.isDelegated && !signal?.aborted && (event.adapter === "milky" ? signal !== undefined : event.boundAccount !== false);
}

function numbered(name: string, variantsFor: (key: string) => Variants | undefined) {
  const digits = /\d+$/u.exec(name);
  if (!digits) return;
  for (let split = Math.max(digits.index, name.length - 16, 1); split < name.length; split++) {
    const key = name.slice(0, split);
    const order = Number(name.slice(split));
    if (!Number.isSafeInteger(order) || order < 1) continue;
    const variants = variantsFor(key);
    const variant = variants?.[order - 1];
    if (variant) return { key, order, variant };
  }
}

function content(event: MessageEvent): InboundSegment[] {
  const segments = typeof event.message === "string" ? [{ type: "text", text: event.message }] : event.message;
  const kept: InboundSegment[] = [];
  for (const part of segments) {
    if (part.type === "text" && typeof part.text === "string" && part.text.length) {
      kept.push({ type: "text", text: part.text });
    } else if (part.type === "at" && String(part.qq) !== String(event.self_id) &&
        (typeof part.qq === "string" || isId(part.qq))) {
      kept.push({ type: "at", qq: part.qq });
    } else if (part.type === "face" && (typeof part.id === "string" || Number.isSafeInteger(part.id))) {
      kept.push({ type: "face", id: part.id });
    } else if (isKeywordMedia(part.type)) kept.push(part);
  }
  return kept;
}

function inlineMedia(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !value.startsWith("base64://")) return;
  const bytes = decodeChatFileBytes(value);
  if (!bytes) return;
  const encoded = value.slice("base64://".length);
  if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") ===
      encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")) return bytes;
}

export function createKeywords(
  store: KeywordStore,
  resolveSettings: (event: MessageEvent, groupId?: number) => Settings,
  now: () => number = () => performance.now(),
  recentStore?: RecentGroupStore,
  readMedia = readQqMessageMedia,
) {
  const drafts = new Map<string, Draft>();
  const groups = new Map<string, { readonly id: number; readonly expires: number }>();
  const groupWrites = new Map<string, Promise<void>>();
  let draftMediaBytes = 0;
  let mediaDownloads = 0;

  async function captureMedia(part: InboundSegment, signal: AbortSignal): Promise<Uint8Array | undefined> {
    const embedded = inlineMedia(part.file) ?? inlineMedia(part.url);
    if (embedded) return embedded;
    if (signal.aborted || mediaDownloads >= maxMediaDownloads) return;
    mediaDownloads++;
    try {
      const direct = await readMedia(part.url ?? part.file, signal).catch(() => undefined);
      if (direct || signal.aborted || typeof part.getDownloadUrl !== "function") return direct;
      const fresh = await part.getDownloadUrl();
      if (!signal.aborted) return await readMedia(fresh, signal);
    } catch {
      return;
    } finally {
      mediaDownloads--;
    }
  }

  function addParts(draft: Draft, parts: readonly InboundSegment[]) {
    for (const part of parts) {
      if (!isKeywordMedia(part.type)) {
        draft.segments.push(part);
        continue;
      }
      const index = draft.segments.push(undefined) - 1;
      draft.pending = (draft.pending ?? Promise.resolve()).then(async () => {
        if (draft.active.aborted) return;
        const file = draft.bytes < maxChatFileBytes ? await captureMedia(part, draft.active) : undefined;
        if (draft.active.aborted) return;
        if (!(file instanceof Uint8Array) || file.byteLength === 0 || draft.bytes + file.byteLength > maxChatFileBytes ||
            draftMediaBytes + file.byteLength > maxDraftMediaBytes) {
          draft.omitted++;
          return;
        }
        draft.bytes += file.byteLength;
        draftMediaBytes += file.byteLength;
        draft.segments[index] = { type: part.type, file };
      });
    }
  }

  async function remember(actor: string, group: number) {
    groups.delete(actor);
    groups.set(actor, { id: group, expires: now() + recentGroupTtl });
    if (groups.size > maxRecentGroups) groups.delete(groups.keys().next().value!);
    if (!recentStore) return;

    const write = (groupWrites.get(actor) ?? Promise.resolve()).then(() => recentStore.write(actor, group)).catch(() => {});
    groupWrites.set(actor, write);
    await write;
    if (groupWrites.get(actor) === write) groupWrites.delete(actor);
  }

  async function recent(actor: string): Promise<{ group?: number; useLegacy: boolean }> {
    const group = groups.get(actor);
    if (group && group.expires > now()) return { group: group.id, useLegacy: false };
    groups.delete(actor);
    const result = await recentStore?.read(actor).then(
      id => isId(id) ? { group: id, useLegacy: false } : { useLegacy: true },
      () => ({ useLegacy: false }),
    );
    const updated = groups.get(actor);
    if (updated && updated.expires > now()) return { group: updated.id, useLegacy: false };
    return result ?? { useLegacy: false };
  }

  const legacy = recentStore?.legacy;

  function allowsLegacyGroup(event: MessageEvent, group: number): boolean {
    return event[delegationSession]?.signal !== undefined && hasKeywordSession(event) && legacy?.allows(event, group) === true;
  }

  async function readLegacyGroup(event: MessageEvent): Promise<number | undefined> {
    if (!legacy || !isId(event.user_id) || !event[delegationSession]?.signal || !hasKeywordSession(event)) return;
    const group = await legacy.read(event.user_id).catch(() => undefined);
    if (isId(group) && allowsLegacyGroup(event, group)) return group;
  }

  async function checkLegacyMember(event: MessageEvent, group: number, actor?: string): Promise<GroupRole | undefined> {
    if (!allowsLegacyGroup(event, group)) return;
    // The old key identifies a group, and the current connection supplies the member role.
    const role = await event.getGroupRole?.(group).catch(() => undefined);
    if (!role) return;
    if (actor !== undefined) {
      const scoped = await recent(actor);
      if (!scoped.useLegacy && scoped.group !== group) return;
    }
    if (await readLegacyGroup(event) === group) return role;
  }

  function allowsCompatibilityList(event: MessageEvent, scope: Scope): boolean {
    return hasKeywordSession(event) && (scope === "global" || legacy?.allows(event, scope) !== false);
  }

  async function permission(event: MessageEvent, scope: Scope, verifiedRole?: GroupRole): Promise<string | undefined> {
    if (!hasKeywordSession(event)) return unboundMessage;
    if (event.adapter === "milky" ? isMilkyOwnerSession(event) : event.isMaster) return;
    if (scope === "global") return "暂无权限，只有主人才能操作全局词条。";
    const settings = resolveSettings(event, scope);
    if (settings.addLimit === 2) return "暂无权限，只有主人才能操作。";
    if (event.message_type === "private" && !settings.addPrivate) return "禁止私聊管理词条。";
    if (settings.addLimit !== 1) return;

    if (event.message_type === "group") {
      if (event.member?.is_admin || event.member?.is_owner) return;
    } else {
      const role = verifiedRole ?? await event.getGroupRole?.(scope).catch(() => undefined);
      if (role === "owner" || role === "admin") return;
      if (role !== "member") return "无法确认管理员权限，请在群内操作。";
    }
    return "暂无权限，只有群管理员才能操作。";
  }

  async function list(event: MessageEvent, scope: Scope, argument: string, {
    legacyGroup, includeGlobal = false, sessionRequired = false,
  }: { legacyGroup?: number; includeGlobal?: boolean; sessionRequired?: boolean } = {}) {
    const active = () => (!sessionRequired || allowsCompatibilityList(event, scope)) &&
      (legacyGroup === undefined || allowsLegacyGroup(event, legacyGroup));
    if (sessionRequired && !active()) return;
    const listMode = !argument || argument.startsWith("列表");
    const page = listMode && argument ? Number(argument.slice(2).trim() || "1") : 1;
    if (listMode && ((!/^列表\s*\d*$/u.test(argument) && argument !== "") || !Number.isSafeInteger(page) || page < 1)) {
      await event.reply("页码须为大于 0 的整数。");
      return;
    }

    let entries: ReadonlyMap<string, Variants>;
    try {
      const [local, global] = await Promise.all([store.read(scope), includeGlobal ? store.read("global") : undefined]);
      // The original merged catalog kept the group entry for a duplicate key.
      entries = global ? new Map([...global, ...local]) : local;
    } catch {
      if (active()) await event.reply("读取词条失败，请稍后重试。");
      return;
    }
    if (!active()) return;
    const rows = [...entries]
      .filter(([name]) => listMode || name.includes(argument))
      .map(([name, versions], index) => `${index + 1}. ${name}(${versions.length})`)
      .reverse();
    if (!rows.length) {
      await event.reply("暂无消息。");
      return;
    }
    const pages = Math.ceil(rows.length / pageSize);
    if (page > pages) {
      await event.reply(`消息列表共有 ${pages} 页。`);
      return;
    }

    const title = listMode ? `消息列表：第${page}页，共${rows.length}条` : `消息${argument}：共${rows.length}条`;
    const body = rows.slice((page - 1) * pageSize, page * pageSize).join("\n");
    const pageCommand = includeGlobal ? "#合并词条列表" : scope === "global" ? "#全局消息列表" : "#消息列表";
    const pagesHint = listMode && page < pages
      ? `更多内容请翻页查看\n如：${pageCommand}${page + 1}` : undefined;
    const nodes = pagesHint ? [title, body, pagesHint] : [title, body];
    let forwarded: boolean | undefined;
    try {
      forwarded = await event.forward?.(nodes);
    } catch {
      if (active()) await event.reply("词条列表转发结果未确认，请在聊天中核对。");
      return;
    }
    if (!forwarded && active()) await event.reply(nodes.join("\n"));
  }

  async function remove(event: MessageEvent, scope: Scope, argument: string, legacyGroup?: number) {
    let removed: boolean;
    let label = argument;
    try {
      const entries = await store.read(scope);
      const indexed = entries.has(argument) ? undefined : numbered(argument, (key) => entries.get(key));
      if (!hasKeywordSession(event) || (legacyGroup !== undefined && !allowsLegacyGroup(event, legacyGroup))) return;
      removed = await store.remove(scope, indexed?.key ?? argument, indexed?.order);
      if (indexed) label = `${indexed.key}(${indexed.order})`;
    } catch {
      await event.reply("删除词条失败，请稍后重试。");
      return;
    }
    await event.reply(removed ? `删除成功：${label}` : "删除错误：没有添加此关键词。");
  }

  async function resume(event: MessageEvent): Promise<boolean> {
    const sender = identity(event);
    if (!sender) return false;
    const draft = drafts.get(sender.chat);
    if (!draft) return false;
    const finishing = event.msg.trim() === finishCommand;
    if (draft.active.aborted || draft.expires <= now()) {
      drafts.delete(sender.chat);
      draft.controller.abort();
      if (!finishing || !hasKeywordSession(event)) return false;
      await event.reply("添加已失效，请重新添加。");
      return true;
    }
    if (!hasKeywordSession(event) || draft.signal !== event[delegationSession]?.signal) return false;

    if (!finishing) {
      const parts = content(event);
      if (draft.segments.length + parts.length > maxDraftSegments) {
        await event.reply("词条片段过多，未收录这条消息。请发送 #结束添加 保存已收录的内容。");
      } else {
        addParts(draft, parts);
      }
      return true;
    }

    drafts.delete(sender.chat);
    try {
      await draft.pending;
      if (!hasKeywordSession(event)) return true;
      const legacyGroup = draft.legacyGroup;
      const role = legacyGroup !== undefined && await readLegacyGroup(event) === legacyGroup
        ? await checkLegacyMember(event, legacyGroup) : undefined;
      const denied = legacyGroup !== undefined && role === undefined ? "添加已失效，请重新添加。"
        : await permission(event, draft.scope, role);
      if (!hasKeywordSession(event)) return true;
      if (draft.active.aborted || draft.expires <= now()) {
        await event.reply("添加已失效，请重新添加。");
        return true;
      }
      const parts = draft.segments.filter(part => part !== undefined);
      const omitted = draft.omitted ? `有 ${draft.omitted} 个媒体下载失败或超过限额，请重新发送。` : "";
      if (denied || !parts.length) {
        await event.reply(denied ?? `添加错误：没有添加内容。${omitted}`);
        return true;
      }
      let count: number;
      try {
        count = await store.append(draft.scope, draft.name, parts, draft.active);
      } catch {
        if (hasKeywordSession(event)) await event.reply("保存词条失败，请重新添加。");
        return true;
      }
      await event.reply(`添加成功：${draft.name}${count > 1 ? `(${count})` : ""}${omitted ? `。${omitted}` : ""}`);
      return true;
    } finally {
      draft.controller.abort();
    }
  }

  async function trigger(event: MessageEvent, group: number, name: string, authorize?: () => Promise<GroupRole | undefined>): Promise<boolean> {
    let reply: MessageReply | undefined;
    let found = false;
    try {
      const [local, global] = await Promise.all([
        store.read(group).catch(() => undefined), store.read("global").catch(() => undefined),
      ]);
      const variantsFor = (key: string) => {
        const first = local?.get(key);
        const last = global?.get(key);
        return first && last ? [...first, ...last] : first ?? last;
      };
      const variants = variantsFor(name);
      const variant = variants?.length ? variants[Math.floor(Math.random() * variants.length)] : numbered(name, variantsFor)?.variant;
      if (!variant) return false;
      if (authorize && !await authorize()) return false;
      found = true;
      reply = await store.render(variant);
    } catch {
      if (!found) return false;
    }

    if (authorize && !allowsLegacyGroup(event, group)) return false;
    if (reply === undefined) {
      await event.reply("该词条的内容当前无法发送。");
    } else {
      const { addReply, addAt, addRecall } = resolveSettings(event, group);
      await event.reply(reply, addReply, { at: addAt, recallMsg: addRecall });
    }
    return true;
  }

  async function dispatch(event: MessageEvent): Promise<boolean> {
    const sender = identity(event);
    if (!sender) return false;
    if (sender.group !== undefined && hasKeywordSession(event)) await remember(sender.actor, sender.group);
    const name = event.msg.trim();
    if (!name) return false;
    if (name === finishCommand) {
      if (event.isDelegated) return false;
      await event.reply("目前没有正在添加的词条。");
      return true;
    }
    const directory = compatibilityDirectory.exec(name);
    if (directory) {
      if (!hasKeywordSession(event)) return true;
      const argument = directory[2]!.trim();
      if (directory[1] === "全局表情") {
        await list(event, "global", argument, { sessionRequired: true });
        return true;
      }
      const scoped = sender.group === undefined ? await recent(sender.actor) : undefined;
      const legacyGroup = scoped?.useLegacy ? await readLegacyGroup(event) : undefined;
      const group = sender.group ?? scoped?.group ?? legacyGroup;
      let role: GroupRole | undefined;
      if (group !== undefined && sender.group === undefined && allowsCompatibilityList(event, group)) {
        role = legacyGroup === undefined ? await event.getGroupRole?.(group).catch(() => undefined)
          : await checkLegacyMember(event, legacyGroup, sender.actor);
      }
      if (!hasKeywordSession(event)) return true;
      if (group === undefined || !allowsCompatibilityList(event, group) || (sender.group === undefined && (!role ||
          (legacyGroup === undefined && (await recent(sender.actor)).group !== group)))) {
        if (hasKeywordSession(event)) await event.reply("请在所属群发送 #合并词条列表。");
        return true;
      }
      await list(event, group, argument, { legacyGroup, includeGlobal: true, sessionRequired: true });
      return true;
    }
    const command = managementCommand.exec(name);
    const scoped = sender.group === undefined && !command?.[1] ? await recent(sender.actor) : undefined;
    const group = sender.group ?? scoped?.group;
    const legacyGroup = scoped?.useLegacy ? await readLegacyGroup(event) : undefined;
    const authorizeLegacy = legacyGroup === undefined ? undefined : () => checkLegacyMember(event, legacyGroup, sender.actor);
    if (!command) {
      if (group !== undefined) return trigger(event, group, name);
      return legacyGroup !== undefined && trigger(event, legacyGroup, name, authorizeLegacy);
    }

    const [, global, action, suffix] = command;
    if (event.isDelegated && action === "添加") return false;
    const argument = suffix?.trim() ?? "";
    const role = await authorizeLegacy?.();
    const scope = global ? "global" : group ?? (role ? legacyGroup : undefined);
    if (scope === undefined) {
      await event.reply("请先在群内发送消息，确定词条所属的群。");
      return true;
    }
    if (action === "消息" || action === "词条") {
      await list(event, scope, argument, { legacyGroup });
      return true;
    }
    const denied = await permission(event, scope, role);
    if (denied || !argument) {
      await event.reply(denied ?? `${action}错误：没有关键词。`);
      return true;
    }
    if (!hasKeywordSession(event)) return true;
    if (action === "删除") {
      await remove(event, scope, argument, legacyGroup);
      return true;
    }

    const time = now();
    for (const [chat, draft] of drafts) {
      if (!draft.active.aborted && draft.expires > time) continue;
      drafts.delete(chat);
      draft.controller.abort();
    }
    if (drafts.size >= maxDrafts && !drafts.has(sender.chat)) {
      await event.reply("当前添加会话较多，请稍后重试。");
      return true;
    }
    drafts.get(sender.chat)?.controller.abort();
    const signal = event[delegationSession]?.signal;
    const controller = new AbortController();
    const sources = [controller.signal, AbortSignal.timeout(draftTtl)];
    if (signal) sources.push(signal);
    const active = AbortSignal.any(sources);
    const draft: Draft = { scope, name: argument, expires: time + draftTtl, segments: [], signal, legacyGroup,
      controller, active, bytes: 0, omitted: 0 };
    active.addEventListener("abort", () => {
      draftMediaBytes -= draft.bytes;
      draft.segments.length = 0;
    }, { once: true });
    drafts.set(sender.chat, draft);
    await event.reply("请发送添加内容，完成后发送#结束添加", true, { at: true });
    return true;
  }

  return { continue: resume, dispatch };
}
