import { keywordMediaUrl } from "./keyword-store.ts";
import type { InboundSegment, MessageEvent, MessageReply } from "./messages.ts";

type Scope = number | "global";
type Variants = readonly (readonly InboundSegment[])[];

interface KeywordStore {
  read(scope: Scope): Promise<ReadonlyMap<string, Variants>>;
  append(scope: Scope, key: string, segments: readonly InboundSegment[]): Promise<number>;
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
  readonly segments: InboundSegment[];
}

interface RecentGroupStore {
  read(actor: string): Promise<number | undefined>;
  write(actor: string, id: number): Promise<void>;
}

const pageSize = 100;
const draftTtl = 120_000;
const recentGroupTtl = 30 * 24 * 60 * 60_000;
const maxDrafts = 1024;
const maxRecentGroups = 4096;
const maxDraftSegments = 1000;
const finishCommand = "#结束添加";
const managementCommand = /^#(全局)?(添加|删除|消息|词条)([\s\S]*)$/u;

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function identity(event: MessageEvent) {
  const { self_id: bot, user_id: user } = event;
  if (!isId(bot) || !isId(user) || bot === user) return;
  const actor = `${bot}:${user}`;
  if (event.message_type === "private") return { actor, chat: `${actor}:private` };
  if (event.message_type === "group" && isId(event.group_id)) {
    return { actor, chat: `${actor}:group:${event.group_id}`, group: event.group_id };
  }
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
    } else if (part.type === "image" || part.type === "record" || part.type === "video") {
      const file = keywordMediaUrl(part.url) ?? keywordMediaUrl(part.file);
      if (file) kept.push({ type: part.type, file });
    }
  }
  return kept;
}

export function createKeywords(
  store: KeywordStore,
  resolveSettings: (event: MessageEvent, groupId?: number) => Settings,
  now: () => number = () => performance.now(),
  recentStore?: RecentGroupStore,
) {
  const drafts = new Map<string, Draft>();
  const groups = new Map<string, { readonly id: number; readonly expires: number }>();
  const groupWrites = new Map<string, Promise<void>>();

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

  async function recent(actor: string): Promise<number | undefined> {
    const group = groups.get(actor);
    if (group && group.expires > now()) return group.id;
    groups.delete(actor);
    const id = await recentStore?.read(actor).catch(() => undefined);
    const updated = groups.get(actor);
    if (updated && updated.expires > now()) return updated.id;
    return isId(id) ? id : undefined;
  }

  async function permission(event: MessageEvent, scope: Scope): Promise<string | undefined> {
    if (event.boundAccount === false) return "请通过已绑定的机器人连接管理词条。";
    if (event.isMaster) return;
    if (scope === "global") return "暂无权限，只有主人才能操作全局词条。";
    const settings = resolveSettings(event, scope);
    if (settings.addLimit === 2) return "暂无权限，只有主人才能操作。";
    if (event.message_type === "private" && !settings.addPrivate) return "禁止私聊管理词条。";
    if (settings.addLimit !== 1) return;

    if (event.message_type === "group") {
      if (event.member?.is_admin || event.member?.is_owner) return;
    } else {
      const role = await event.getGroupRole?.(scope).catch(() => undefined);
      if (role === "owner" || role === "admin") return;
      if (role !== "member") return "无法确认管理员权限，请在群内操作。";
    }
    return "暂无权限，只有群管理员才能操作。";
  }

  async function list(event: MessageEvent, scope: Scope, argument: string) {
    const listMode = !argument || argument.startsWith("列表");
    const page = listMode && argument ? Number(argument.slice(2).trim() || "1") : 1;
    if (listMode && ((!/^列表\s*\d*$/u.test(argument) && argument !== "") || !Number.isSafeInteger(page) || page < 1)) {
      await event.reply("页码须为大于 0 的整数。");
      return;
    }

    let entries: ReadonlyMap<string, Variants>;
    try {
      entries = await store.read(scope);
    } catch {
      await event.reply("读取词条失败，请稍后重试。");
      return;
    }
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
    const pagesHint = listMode && page < pages
      ? `更多内容请翻页查看\n如：#${scope === "global" ? "全局" : ""}消息列表${page + 1}` : undefined;
    const nodes = pagesHint ? [title, body, pagesHint] : [title, body];
    let forwarded: boolean | undefined;
    try {
      forwarded = await event.forward?.(nodes);
    } catch {
      await event.reply("词条列表转发结果未确认，请在聊天中核对。");
      return;
    }
    if (!forwarded) await event.reply(nodes.join("\n"));
  }

  async function remove(event: MessageEvent, scope: Scope, argument: string) {
    let removed: boolean;
    let label = argument;
    try {
      const entries = await store.read(scope);
      const indexed = entries.has(argument) ? undefined : numbered(argument, (key) => entries.get(key));
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
    if (draft.expires <= now()) {
      drafts.delete(sender.chat);
      if (finishing) await event.reply("添加已失效，请重新添加。");
      return finishing;
    }

    if (!finishing) {
      if (event.boundAccount === false) return false;
      const parts = content(event);
      if (draft.segments.length + parts.length > maxDraftSegments) {
        await event.reply("词条片段过多，未收录这条消息。请发送 #结束添加 保存已收录的内容。");
      } else {
        draft.segments.push(...parts);
      }
      return true;
    }

    drafts.delete(sender.chat);
    const denied = await permission(event, draft.scope);
    if (denied || !draft.segments.length) {
      await event.reply(denied ?? "添加错误：没有添加内容。");
      return true;
    }
    let count: number;
    try {
      count = await store.append(draft.scope, draft.name, draft.segments);
    } catch {
      await event.reply("保存词条失败，请重新添加。");
      return true;
    }
    await event.reply(`添加成功：${draft.name}${count > 1 ? `(${count})` : ""}`);
    return true;
  }

  async function trigger(event: MessageEvent, group: number, name: string): Promise<boolean> {
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
      found = true;
      reply = await store.render(variant);
    } catch {
      if (!found) return false;
    }

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
    if (sender.group !== undefined && event.boundAccount !== false) await remember(sender.actor, sender.group);
    const name = event.msg.trim();
    const group = sender.group ?? await recent(sender.actor);
    if (name === finishCommand) {
      await event.reply("目前没有正在添加的词条。");
      return true;
    }
    const command = managementCommand.exec(name);
    if (!command) return group !== undefined && !!name && trigger(event, group, name);

    const [, global, action, suffix] = command;
    const argument = suffix?.trim() ?? "";
    const scope = global ? "global" : group;
    if (scope === undefined) {
      await event.reply("请先在群内发送消息，确定词条所属的群。");
      return true;
    }
    if (action === "消息" || action === "词条") {
      await list(event, scope, argument);
      return true;
    }
    const denied = await permission(event, scope);
    if (denied || !argument) {
      await event.reply(denied ?? `${action}错误：没有关键词。`);
      return true;
    }
    if (action === "删除") {
      await remove(event, scope, argument);
      return true;
    }

    const time = now();
    for (const [chat, draft] of drafts) if (draft.expires <= time) drafts.delete(chat);
    if (drafts.size >= maxDrafts && !drafts.has(sender.chat)) {
      await event.reply("当前添加会话较多，请稍后重试。");
      return true;
    }
    drafts.set(sender.chat, { scope, name: argument, expires: time + draftTtl, segments: [] });
    await event.reply("请发送添加内容，完成后发送#结束添加", true, { at: true });
    return true;
  }

  return { continue: resume, dispatch };
}
