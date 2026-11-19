import { readLocalConfig } from "./config.ts";
import { isMilkyOwnerSession } from "./command-permissions.ts";
import type { BotEvent, MessageEvent } from "./messages.ts";

const defaults = { groupCD: 500, singleCD: 2_000, onlyReplyAt: 0, botAlias: ["云崽", "云宝"] };

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
  ["椰奶小助手", ["[group] 群名片"]],
  ["椰奶点赞", ["[group] 资料卡点赞"]],
  ["椰奶群管-基础", ["[group] 群禁言", "[group] 群成员移出", "[group] 群头衔", "[group] 群管理员", "[group] 群禁言列表", "[group] 从未发言成员"]],
  ["椰奶群管-黑白名单", ["[group] 群管黑名单", "[group] 群管白名单"]],
  ["椰奶群管-违禁词", ["[group] 违禁词", "[group] 头衔屏蔽词"]],
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

async function readRoutingConfig(root: URL): Promise<Record<string, unknown> | undefined> {
  for (const path of ["config/group.yaml", "config/config/group.yaml"]) {
    const file = Bun.file(new URL(path, root));
    if (!await file.exists()) continue;
    try {
      const value: unknown = Bun.YAML.parse(await file.text());
      if (value != null && (typeof value !== "object" || Array.isArray(value))) throw new Error();
      const config = record(value);
      // Lotus likes settings also use config/group.yaml, with flat keys.
      if (Object.keys(config).some((key) => /^(?:default|[1-9]\d*(?::(?:default|[1-9]\d*))?)$/u.test(key))) {
        return config;
      }
    } catch {
      throw new Error(`无法读取 ${path}。`);
    }
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

export async function readGroupDispatch(root: URL) {
  const [other, groups, botConfig] = await Promise.all([
    readLocalConfig(root, "other"), readRoutingConfig(root), readLocalConfig(root, "bot"),
  ]);
  const whiteUser = ids(other.whiteUser);
  const blackUser = ids(other.blackUser);
  const whiteGroup = ids(other.whiteGroup);
  const blackGroup = ids(other.blackGroup);
  const groupCooldowns = new Cooldowns();
  const memberCooldowns = new Cooldowns();
  const duplicates = new Cooldowns();
  const slashAlias = botConfig["/→#"] === true || botConfig["/→#"] === 1;

  function normalizePrefix(text: string): string {
    if (slashAlias) text = text.replace(/^\/\s*/u, "#");
    return text.replace(/^[＃井]\s*/u, "#").replace(/^[＊※]\s*/u, "*");
  }

  function groupConfig(event: { self_id?: number; group_id?: number }, groupId?: number): Record<string, unknown> {
    if (!groups) return {};
    const bot = id(event.self_id);
    const group = id(groupId ?? event.group_id);
    return {
      ...defaults,
      ...record(groups.default),
      ...(bot ? record(groups[`${bot}:default`]) : {}),
      ...(group ? record(groups[group]) : {}),
      ...(bot && group ? record(groups[`${bot}:${group}`]) : {}),
    };
  }

  // Moderation relies on replaying the group policy even for a globally blocked applicant.
  function allowsGroupModeration(event: GroupRoutingScope): boolean {
    const user = id(event.user_id);
    const group = "group_id" in event ? id(event.group_id) : undefined;
    return !(whiteUser.size && (!user || !whiteUser.has(user))) &&
      !(group && (!passesGroupList(group) || isBotMuted(event)));
  }

  function passesGroupList(group: string) {
    return !blackGroup.has(group) && (whiteGroup.size === 0 || whiteGroup.has(group));
  }

  function admit(event: BotEvent): boolean {
    if (event.post_type === "message" && event.message_type === "terminal") return true;
    const user = id(event.user_id);
    if ((user && blackUser.has(user)) || !allowsGroupModeration(event)) return false;
    const group = "group_id" in event ? id(event.group_id) : undefined;
    if (!groups || event.post_type !== "message" || event.message_type !== "group" || !group || event.isDelegated) return true;

    const config = groupConfig(event);
    const now = performance.now();
    if (cooldown(config.groupCD) && groupCooldowns.active(group, now)) return false;
    if (user && cooldown(config.singleCD) && memberCooldowns.active(`${group}:${user}`, now)) return false;

    const bot = id(event.self_id) ?? "";
    const duplicate = event.adapter === "milky" && event.file && event.message_id !== undefined
      ? `milky:file:${bot}:${group}:${user ?? ""}:${event.message_id}`
      : `${bot}:${user ?? ""}:${event.raw_message}`;
    if (duplicates.active(duplicate, now)) return false;
    duplicates.set(duplicate, now, 1_000);
    return true;
  }

  function prepare(event: MessageEvent): { event: MessageEvent; allowNew: boolean } {
    const msg = normalizePrefix(event.msg);
    if (!groups || event.message_type !== "group") {
      return { event: msg === event.msg ? event : { ...event, msg }, allowNew: true };
    }

    const config = groupConfig(event);
    const alias = !event.atBot && strings(config.botAlias).find((text) => msg.startsWith(text));
    const mode = config.onlyReplyAt;
    const owner = event.isMaster || isMilkyOwnerSession(event);
    const needsAddress = !!config.botAlias && (mode === 1 || mode === "1" || ((mode === 2 || mode === "2") && !owner));
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
    return { event: normalized, allowNew };
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
    return {
      addLimit: limit === 1 ? 1 as const : limit === 2 ? 2 as const : 0 as const,
      addPrivate: addPrivate === undefined || addPrivate === true || addPrivate === 1 || addPrivate === "1",
      addReply: addReply === undefined || addReply === true || addReply === 1 || addReply === "1",
      addAt: addAt === true || addAt === 1 || addAt === "1",
      addRecall: Math.min(cooldown(addRecall ?? 60), 120),
    };
  }

  function blockUser(userId: number): void {
    const user = id(userId);
    if (user) blackUser.add(user);
  }

  return { admit, prepare, allows, allowsGroupModeration, allowsScheduledGroup, blockUser, keywordSettings };
}
