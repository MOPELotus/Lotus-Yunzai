import { watchConfigFiles } from "./config-watch.ts";
import { readLocalConfig } from "./config.ts";
import { isMilkyOwnerSession } from "./command-permissions.ts";
import { isGroupJoinReviewInput } from "./group-join-review.ts";
import { groupModerationSession } from "./adapters/group-moderation.ts";
import type { BotEvent, MessageEvent } from "./messages.ts";

const defaults = {
  groupCD: 500, singleCD: 2_000, onlyReplyAt: 0, botAlias: ["云崽", "云宝"],
  addPrivate: 1, addReply: 1, addRecall: 60,
};

const legacyFeatureSelectors = new Map<string, readonly string[]>([
  ["[Lotus-Plugin] Device", ["@lotus-yunzai/device"]],
  ["[Lotus-Plugin] Daily Note", ["@lotus-yunzai/daily-note"]],
  ["[Lotus-Plugin] Redeem Codes", ["@lotus-yunzai/redeem-codes"]],
  ["[Lotus-Plugin] Coin Shop", ["@lotus-yunzai/miyoushe"]],
  ["[Lotus-Plugin] Profile Settings", ["@lotus-yunzai/hoyolab-profile", "@lotus-yunzai/cloud-profile",
    "@lotus-yunzai/checkin-registration", "@lotus-yunzai/checkin-group-registration", "@lotus-yunzai/checkin-profile"]],
  ["[Lotus-Plugin] Checkin", ["@lotus-yunzai/checkin"]],
  ["[Lotus-Plugin] Checkin Admin", ["@lotus-yunzai/checkin-admin", "@lotus-yunzai/checkin-roster", "@lotus-yunzai/checkin-batch-refresh"]],
  ["[Lotus-Plugin] Scheduler", ["@lotus-yunzai/checkin-plan", "@lotus-yunzai/checkin-schedule-settings"]],
  ["[Lotus-Plugin] Login", ["@lotus-yunzai/passport-login"]],
  ["[Lotus-Plugin] Gacha Log", ["[gacha] 抽卡记录"]],
  ["[Lotus-Plugin] Music", ["[media] 点歌"]],
  ["[Lotus-Plugin] Bilibili", ["[media] B 站解析"]],
  ["[Lotus-Plugin] Douyin", ["[media] 抖音解析"]],
  ["椰奶小助手", ["[group] 群名片", "回复撤回"]],
  ["椰奶点赞", ["[group] 资料卡点赞"]],
  ["椰奶助手-其他", ["[group] 图片文字识别", "头像", "群头像", "取face", "取直链", "日志等级"]],
  ["椰奶助手-发消息", ["[group] 消息代发"]],
  ["椰奶配置-index", ["[group] 设置"]],
  ["椰奶配置-通知", ["[group] 通知设置"]],
  ["椰奶群管-基础", ["[group] 群禁言", "[group] 群成员移出", "[group] 群头衔", "[group] 群管理员", "[group] 群禁言列表",
    "[group] 从未发言成员", "[group] 群成员活动排行", "[group] 群精华", "[group] 自助禁言", "[group] 定时群禁言", "[group] 群通知",
    "[group] 加群申请通知", "[group] 引用加群审核"]],
  ["椰奶群管-黑白名单", ["[group] 群管黑名单", "[group] 群管白名单"]],
  ["椰奶群管-违禁词", ["[group] 违禁词", "[group] 头衔屏蔽词"]],
  ["椰奶群管-群公告", ["[group] 群公告"]],
  ["椰奶群管-投票", ["[group] 群投票"]],
  ["椰奶群管-入群验证", ["[group] 入群验证"]],
  ["椰奶私聊群管", ["[group] 私聊群管"]],
  ["椰奶申请处理", ["[group] 加群申请列表", "[group] 引用加群审核", "[group] 加群申请审核"]],
  ["复读", ["主动复读"]],
  ["genshin-inventory", ["[genshin] 背包"]],
  ["genshin-world-boss-kill-count-inventory", ["[genshin] 世界 BOSS"]],
  ["AutoCalendar", ["[guides] 定时日历"]],
  ["抽卡期望计算", ["[gacha] 抽卡期望"]],
  ["椰奶状态", ["[system] 状态"]],
  ["状态统计", ["[system] 状态", "[system] 消息统计"]],
  ["meme-plugin", ["[meme] 表情合成"]],
  ["清语表情", ["[meme] 表情合成"]],
  ["清语表情:表情包生成", ["[meme] 表情合成"]],
]);

function featureSelectors(names: readonly string[]): string[] {
  return names.flatMap(name => legacyFeatureSelectors.get(name) ?? [name]);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function id(value: unknown): string | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? String(number) : undefined;
}

function ids(value: unknown): Set<string> {
  const entries = Array.isArray(value) ? value : [value];
  return new Set(entries.map(id).filter((entry) => entry !== undefined));
}

function cooldown(value: unknown): number {
  const time = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  return typeof time === "number" && Number.isInteger(time) && time > 0 && time <= 2_147_483_647 ? time : 0;
}

async function readRoutingConfig(root: URL) {
  const legacyPath = "config/config/group.yaml";
  for (const path of ["config/group.yaml", legacyPath]) {
    const file = Bun.file(new URL(path, root));
    if (!await file.exists()) continue;
    try {
      const value: unknown = Bun.YAML.parse(await file.text());
      if (value != null && (typeof value !== "object" || Array.isArray(value))) throw new Error();
      const config = record(value);
      const keys = Object.keys(config);
      const legacy = path === legacyPath;
      // An empty TRSS runtime overlay still inherited its bundled group defaults.
      if (legacy && keys.length === 0) return { config, legacy };
      // Lotus likes settings also use config/group.yaml, with flat keys.
      if (keys.some((key) => /^(?:default|[1-9]\d*(?::(?:default|[1-9]\d*))?)$/u.test(key))) {
        return { config, legacy };
      }
    } catch {
      throw new Error(`无法读取 ${path}。`);
    }
  }
}

async function readSlashAlias(root: URL): Promise<boolean> {
  const active = await readLocalConfig(root, "bot");
  const option = "/→#";
  const enabled = (value: unknown) => value === true || value === 1;
  if (Object.hasOwn(active, option)) return enabled(active[option]);

  // TRSS supplied this key from its default file even in trimmed runtime YAML.
  try {
    const previous: unknown = Bun.YAML.parse(await Bun.file(new URL("config/config/bot.yaml", root)).text());
    if (previous != null && (typeof previous !== "object" || Array.isArray(previous))) return false;
    const legacy = record(previous);
    return !Object.hasOwn(legacy, option) || enabled(legacy[option]);
  } catch {
    return false;
  }
}

interface GroupRoutingScope {
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly post_type?: BotEvent["post_type"];
  readonly message_type?: MessageEvent["message_type"];
  readonly botMute?: MessageEvent["botMute"];
}

function isBotMuted(event: GroupRoutingScope): boolean {
  const mute = "botMute" in event ? record(event.botMute) : {};
  return (typeof mute.remainingSeconds === "number" && mute.remainingSeconds > 0) ||
    (mute.allMembers === true && mute.isAdmin !== true && mute.isOwner !== true);
}

class Cooldowns {
  readonly #deadlines = new Map<string, number>();

  active(key: string, now: number): boolean {
    return (this.#deadlines.get(key) ?? 0) > now;
  }

  set(key: string, now: number, duration: number): void {
    const deadline = now + duration;
    this.#deadlines.set(key, deadline);
    setTimeout(() => {
      if (this.#deadlines.get(key) === deadline) this.#deadlines.delete(key);
    }, duration).unref();
  }
}

async function readRoutingLists(root: URL) {
  const config = await readLocalConfig(root, "other");
  return {
    whiteUser: ids(config.whiteUser), blackUser: ids(config.blackUser),
    whiteGroup: ids(config.whiteGroup), blackGroup: ids(config.blackGroup),
  };
}

function watchRoutingFiles(name: "bot" | "group" | "other", signal: AbortSignal, reload: () => Promise<void>) {
  watchConfigFiles(signal, reload, () => console.warn(`[群派发] ${name}.yaml 重载失败，保留上次有效设置。`));
}

export async function readGroupDispatch(root: URL, watchSignal?: AbortSignal) {
  let [lists, groups, slashAlias] = await Promise.all([
    readRoutingLists(root), readRoutingConfig(root), readSlashAlias(root),
  ]);
  const groupCooldowns = new Cooldowns();
  const memberCooldowns = new Cooldowns();
  const duplicates = new Cooldowns();
  let listRevision = 0;

  async function refreshLists() {
    while (!watchSignal?.aborted) {
      const revision = listRevision;
      const updated = await readRoutingLists(root);
      if (revision !== listRevision) continue;
      if (!watchSignal?.aborted) {
        lists = updated;
        listRevision++;
      }
      break;
    }
  }

  if (watchSignal) {
    watchRoutingFiles("bot", watchSignal, async () => {
      const updated = await readSlashAlias(root);
      if (!watchSignal.aborted) slashAlias = updated;
    });
    watchRoutingFiles("group", watchSignal, async () => {
      const updated = await readRoutingConfig(root);
      if (!watchSignal.aborted) groups = updated;
    });
    watchRoutingFiles("other", watchSignal, refreshLists);
  }

  function normalizePrefix(text: string): string {
    if (slashAlias) text = text.replace(/^\/\s*/u, "#");
    return text.replace(/^[＃井]\s*/u, "#").replace(/^[＊※]\s*/u, "*");
  }

  function groupConfig(event: { self_id?: number; group_id?: number }, groupId?: number): Record<string, unknown> {
    if (!groups) return {};
    const { config, legacy } = groups;
    const bot = id(event.self_id);
    const group = id(groupId ?? event.group_id);
    return {
      // TRSS replaced the entire bundled default section when the runtime YAML provided one.
      ...(legacy && Object.hasOwn(config, "default") ? {} : defaults),
      ...record(config.default),
      ...(bot ? record(config[`${bot}:default`]) : {}),
      ...(group ? record(config[group]) : {}),
      ...(bot && group ? record(config[`${bot}:${group}`]) : {}),
    };
  }

  // Moderation relies on replaying the group policy even for a globally blocked applicant.
  function allowsGroupModeration(event: GroupRoutingScope): boolean {
    const user = id(event.user_id);
    const group = "group_id" in event ? id(event.group_id) : undefined;
    return !(lists.whiteUser.size && (!user || !lists.whiteUser.has(user))) &&
      !(group && (!passesGroupList(group) || isBotMuted(event)));
  }

  function passesGroupList(group: string) {
    return !lists.blackGroup.has(group) && (lists.whiteGroup.size === 0 || lists.whiteGroup.has(group));
  }

  function allowsInbound(event: GroupRoutingScope): boolean {
    if (event.post_type === "message" && event.message_type === "terminal") return true;
    const user = id(event.user_id);
    return !(user && lists.blackUser.has(user)) && allowsGroupModeration(event);
  }

  function admitUnique(key: string, now: number): boolean {
    if (duplicates.active(key, now)) return false;
    duplicates.set(key, now, 1_000);
    return true;
  }

  function admit(event: BotEvent): boolean {
    if (!allowsInbound(event)) return false;
    if (event.post_type !== "message" || event.isDelegated) return true;

    const user = id(event.user_id);
    if (event.message_type === "private") {
      const bot = id(event.self_id);
      // File notices and attachment delivery have their own message and file identity checks.
      return (event.adapter !== "milky" && event.boundAccount !== true) ||
        event.message_id === undefined || !bot || !user || !event.raw_message || !event.msg || !!event.file ||
        admitUnique(`${bot}:${user}:${event.raw_message}`, performance.now());
    }
    const group = id(event.group_id);
    if (!groups || event.message_type !== "group" || !group) return true;

    const config = groupConfig(event);
    const now = performance.now();
    if (cooldown(config.groupCD) && groupCooldowns.active(group, now)) return false;
    if (user && cooldown(config.singleCD) && memberCooldowns.active(`${group}:${user}`, now)) return false;

    const bot = id(event.self_id) ?? "";
    let duplicate = `${bot}:${user ?? ""}:${event.raw_message}`;
    if (event.message_id !== undefined) {
      const member = groupModerationSession(event)?.memberMessage;
      const input = normalizePrefix(event.msg);
      const quotedReview = event.groupReviewQuotedRequest && event.reply_id !== undefined && isGroupJoinReviewInput(input);
      const pendingReview = (event.groupReviewPendingJoin || event.groupReviewAllPendingJoins) &&
        /^#?(?:同意|拒绝)(?:全部(?:加|入)?群申请|(?:加|入)?群申请\d+)$/u.test(input);
      if (quotedReview || pendingReview) {
        duplicate = `${event.adapter ?? "onebot"}:group-join-review:${bot}:${group}:${user ?? ""}:${event.message_id}`;
      } else if (event.groupVote && /^#(?:(?:发起)?投票(?:禁言|踢人)|(?:支持|反对)投票)/u.test(input)) {
        duplicate = `${event.adapter ?? "onebot"}:group-vote:${bot}:${group}:${user ?? ""}:${event.message_id}`;
      } else if (member?.readImageMd5 || member?.mixedImageParts) {
        duplicate = `${event.adapter ?? "onebot"}:image:${bot}:${group}:${user ?? ""}:${event.message_id}`;
      } else if (event.adapter === "milky" && event.file) {
        duplicate = `milky:file:${bot}:${group}:${user ?? ""}:${event.message_id}`;
      }
    }
    return admitUnique(duplicate, now);
  }

  function prepare(event: MessageEvent): { event: MessageEvent; allowNew: boolean; alias?: string } {
    const msg = normalizePrefix(event.msg);
    if (!groups || event.message_type !== "group") {
      return { event: msg === event.msg ? event : { ...event, msg }, allowNew: true };
    }

    const config = groupConfig(event);
    const alias = !event.atBot && strings(config.botAlias).find((text) => msg.startsWith(text));
    const mode = config.onlyReplyAt;
    const owner = event.isMaster || isMilkyOwnerSession(event);
    const ownerExempt = (mode === 2 || mode === "2") && owner;
    const needsAddress = !!config.botAlias && !ownerExempt &&
      (groups.legacy ? mode !== 0 && mode !== "0" : mode === 1 || mode === "1" || mode === 2 || mode === "2");
    const allowNew = !needsAddress || !!event.atBot || !!alias;

    const group = id(event.group_id);
    if (allowNew && group && !event.isDelegated) {
      const now = performance.now();
      const groupCD = cooldown(config.groupCD);
      const singleCD = cooldown(config.singleCD);
      const user = id(event.user_id);
      if (groupCD) groupCooldowns.set(group, now, groupCD);
      if (singleCD && user) memberCooldowns.set(`${group}:${user}`, now, singleCD);
    }

    const normalized = {
      ...event,
      msg: alias ? normalizePrefix(msg.slice(alias.length).trimStart()) : msg,
      hasAlias: !!alias,
      only_reply_at: allowNew,
    };
    return { event: normalized, allowNew, ...(alias ? { alias } : {}) };
  }

  function allows(event: GroupRoutingScope, names: readonly string[]): boolean {
    if (event.post_type === "message" && event.message_type === "terminal") return true;
    return featuresAllowed(groupConfig(event), names);
  }

  function allowsScheduledGroup(botId: number, groupId: number, names: readonly string[]): boolean {
    const group = id(groupId);
    return group !== undefined && passesGroupList(group) && featuresAllowed(groupConfig({ self_id: botId }, groupId), names);
  }

  function featuresAllowed(config: Record<string, unknown>, names: readonly string[]): boolean {
    const disabled = featureSelectors(strings(config.disable));
    const enabled = featureSelectors(strings(config.enable));
    const features = featureSelectors(names);
    return !features.some((name) => disabled.includes(name)) &&
      (enabled.length === 0 || features.some((name) => enabled.includes(name)));
  }

  function keywordSettings(event: MessageEvent, groupId?: number) {
    const { addLimit, addPrivate, addReply, addAt, addRecall } = groupConfig(event, groupId);
    const limit = Number(addLimit);
    const legacy = groups?.legacy === true;
    return {
      addLimit: limit === 1 ? 1 as const : limit === 2 ? 2 as const : 0 as const,
      addPrivate: (addPrivate === undefined && !legacy) || addPrivate === true || addPrivate === 1 || addPrivate === "1",
      addReply: (addReply === undefined && !legacy) || addReply === true || addReply === 1 || addReply === "1",
      addAt: addAt === true || addAt === 1 || addAt === "1",
      addRecall: Math.min(cooldown(legacy ? addRecall : addRecall ?? 60), 120),
    };
  }

  function blockUser(userId: number): void {
    const user = id(userId);
    if (user) {
      lists.blackUser.add(user);
      listRevision++;
    }
  }

  return { admit, prepare, allows, allowsInbound, allowsGroupModeration, allowsScheduledGroup, refreshLists, blockUser, keywordSettings };
}
