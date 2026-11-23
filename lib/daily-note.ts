import { createProfileStore, MAX_PROFILE_ID, ProfileError, profileGames, type Game } from "@lotus-yunzai/account";
import { createProfileHoyoClient, DailyNoteRequestError, HoyoRequestError, type DailyNoteSnapshot } from "@lotus-yunzai/hoyo-client";
import type { DailyNoteCardItem, DailyNoteCardModel } from "@lotus-yunzai/skia/daily-note";
import type { CommandModule } from "./commands.ts";
import type { MessageReply } from "./messages.ts";

const matches = [
  [/^#?(?:多|全|全部)(?:体力|树脂|查询体力|便笺|便签)([1-9]\d{0,2})?$/u, profileGames],
  [/^#?(?:原神)?(?:体力|树脂|查询体力|便笺|便签)([1-9]\d{0,2})?$/u, ["gs"]],
  [/^(?:\*|#*星铁)(?:体力|树脂|查询体力|开拓力|便笺|便签|note|每日)([1-9]\d{0,2})?$/iu, ["sr"]],
  [/^(?:(?:#*|\/)(?:zzz|绝区零|绝区)(?:zzz|绝区零)?|#?[%％](?:zzz|绝区零|绝区)?)(?:体力|树脂|查询体力|note|每日|便笺|便签)([1-9]\d{0,2})?$/iu, ["zzz"]],
] as const;
const names = { gs: "原神", sr: "星铁", zzz: "绝区零" } as const;
const resources = { gs: "树脂", sr: "开拓力", zzz: "电量" } as const;
const videoStates = {
  doing: "营业中", done: "营业已结束", ready: "可以开始营业", idle: "未营业", unknown: "状态待确认",
} as const;
const sectionsPerPage = 6;

function parseCommand(message: string) {
  for (const [pattern, games] of matches) {
    const match = pattern.exec(message);
    if (match) return { games, profileId: match[1] ? Number(match[1]) : undefined };
  }
}

const pair = ({ current, max }: { current?: number; max?: number }) => `${current ?? "-"}/${max ?? "-"}`;

function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return `${hours ? `${hours}小时` : ""}${minutes}分钟`;
}

function noteCardItem(snapshot: DailyNoteSnapshot): DailyNoteCardItem {
  const { game, uid, stamina, homeCoin, expeditions, transformer, videoStore, scratchCardDone } = snapshot;
  const details: { label: string; value: string }[] = [];
  function add(label: string, value: string | number | undefined) {
    if (value !== undefined) details.push({ label, value: String(value) });
  }
  function expedition(label: string, next: string) {
    if (!expeditions) return;
    if (expeditions.current !== undefined || expeditions.max !== undefined) add(label, pair(expeditions));
    if (expeditions.remainingSeconds !== undefined) {
      add(next, expeditions.remainingSeconds === 0 ? "已有完成" : `${duration(expeditions.remainingSeconds)} 后完成`);
    }
  }
  let data: DailyNoteCardItem["data"];
  switch (game) {
    case "gs":
      data = { current_resin: stamina.current, max_resin: stamina.max,
        ...(homeCoin ? { current_home_coin: homeCoin.current, max_home_coin: homeCoin.max } : {}) };
      add("每日委托", snapshot.commissionRewardReceived === undefined ? undefined
        : snapshot.commissionRewardReceived ? "奖励已领取" : "奖励未领取");
      expedition("探索派遣", "最快派遣");
      if (snapshot.weeklyDiscount) add("周本减半", pair(snapshot.weeklyDiscount));
      if (transformer) {
        const seconds = transformer.remainingSeconds;
        const days = seconds === undefined ? 0 : Math.floor(seconds / 86400);
        const remainder = seconds === undefined ? 0 : seconds % 86400;
        const remaining = [days ? `${days}天` : "", remainder ? duration(remainder) : ""].join("");
        add("参量质变仪", transformer.ready ? "可用" : remaining || "冷却中");
      }
      break;
    case "sr":
      data = { current_stamina: stamina.current, max_stamina: stamina.max };
      expedition("委托执行", "最快委托");
      if (snapshot.training) add("每日实训", pair(snapshot.training));
      if (snapshot.rogue) add("模拟宇宙", pair(snapshot.rogue));
      if (snapshot.echoOfWar) add("历战余响", pair(snapshot.echoOfWar));
      add("备用开拓力", snapshot.reserveStamina);
      break;
    case "zzz":
      data = { energy: { progress: stamina } };
      if (snapshot.vitality) add("活跃度", pair(snapshot.vitality));
      if (videoStore) add("录像店", videoStates[videoStore]);
      if (scratchCardDone !== undefined) add("刮刮乐", scratchCardDone ? "已完成" : "未完成");
      break;
  }
  const recovery = stamina.current >= stamina.max ? "已回满"
    : stamina.recoverySeconds && `回满 ${duration(stamina.recoverySeconds)}`;
  const detail = [
    `${resources[game]} ${pair(stamina)}`, homeCoin && `洞天宝钱 ${pair(homeCoin)}`, recovery,
  ].filter(Boolean).join(" · ");
  return { game, gameName: names[game], uid, ok: true, data, detail, details };
}

function failure(error: unknown): string {
  if (error instanceof ProfileError) {
    if (error.code === "missing") return "档案不存在。";
    if (error.code === "login-required") return "档案尚未登录。";
  }
  if (error instanceof DailyNoteRequestError) return error.message;
  if (error instanceof HoyoRequestError && (error.code === "refresh" || error.code === "invalid-input")) return error.message;
  return "体力暂时无法查询。";
}

function pagesOf(groups: DailyNoteCardModel["groups"]): DailyNoteCardModel[] {
  const rows = groups.flatMap(({ name, items }) => items.map((item) => ({ name, item })));
  const generatedAt = new Date().toLocaleString("sv-SE", { hour12: false });
  const pages: DailyNoteCardModel[] = [];
  for (let start = 0; start < rows.length; start += sectionsPerPage) {
    const page = new Map<string, DailyNoteCardItem[]>();
    for (const { name, item } of rows.slice(start, start + sectionsPerPage)) {
      const items = page.get(name) ?? [];
      items.push(item);
      page.set(name, items);
    }
    pages.push({ generatedAt, groups: [...page].map(([name, items]) => ({ name, items })) });
  }
  return pages;
}

function textReply(groups: DailyNoteCardModel["groups"]) {
  return groups.flatMap(({ name, items }) => items.map((item) => {
    const title = [name, item.gameName, item.uid && `UID ${item.uid}`].filter(Boolean).join(" · ");
    const details = [item.ok ? item.detail : item.error,
      ...(item.details ?? []).map(({ label, value }) => `${label} ${value}`)];
    return [title, ...details.filter(Boolean)].join("\n");
  })).join("\n\n");
}

export function dailyNoteCommands(directory: string | undefined, signal: AbortSignal): CommandModule {
  const profiles = createProfileStore(directory);
  const client = createProfileHoyoClient(profiles);
  return {
    name: "@lotus-yunzai/daily-note",
    commands: {},
    async fallback(_message, context) {
      const command = parseCommand(context.normalizedMessage);
      if (!command || signal.aborted) return;
      const { profileId, games } = command;
      if (profileId !== undefined && profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (!user_id || !Number.isSafeInteger(user_id) || user_id < 1) return "请从登录档案对应的 QQ 会话查询体力。";
      const qq = String(user_id);
      await context.reply(profileId
        ? `[account] 正在查询 profile ${profileId} 的体力。`
        : "[account] 正在查询当前 QQ 的所有 profile 体力。");
      const ids = profileId ? [profileId] : await profiles.listIds(qq).catch(() => undefined);
      if (signal.aborted) return;
      if (!ids) return "无法读取档案列表，请稍后再试。";
      if (!ids.length) return "[account] 没有找到可查询的 profile，请先扫码登录并同步 UID。";

      const groups: DailyNoteCardModel["groups"][number][] = [];
      const verifyDelivery: (() => Promise<void>)[] = [];
      const session = context.message_type === "private" && !context.isDelegated
        ? context.privateCredentialSignal : undefined;
      const active = session ? AbortSignal.any([signal, session]) : signal;
      const changed = "[account] 登录状态已变化，本次体力查询已停止，请重新发送原指令。";
      for (const id of ids) {
        if (active.aborted) return [];
        const items: DailyNoteCardItem[] = [];
        try {
          const { sources: saved, verifyReadOnly } = await profiles.requestContextsForRead(qq, id, games);
          const sources = saved.filter(({ game, role }) => game !== "zzz" ||
            (role.gameBiz !== "nap_global" && !/^[1-9]\d{9}$/u.test(role.uid)));
          let revision = sources[0]?.revision;
          const results = await client.fetchDailyNotes(sources, {
            signal: active,
            verifyReadOnly,
            onCredentialRefresh(refreshed) { revision = refreshed.revision; },
          });
          if (revision && results.some(result => result.status === "fulfilled")) {
            verifyDelivery.push(verifyReadOnly ?? (async () => {
              if ((await profiles.checkinSettings(qq, id)).revision !== revision) {
                throw new HoyoRequestError("profile-changed", changed);
              }
            }));
          }
          for (const game of games) {
            const start = items.length;
            sources.forEach((source, index) => {
              if (source.game !== game) return;
              const result = results[index]!;
              items.push(result.status === "fulfilled" ? noteCardItem(result.value)
                : { game, gameName: names[game], uid: source.role.uid, ok: false, error: failure(result.reason) });
            });
            if (game === "zzz") {
              const international = await profiles.internationalRoleContext(qq, id, "zzz");
              if (international && (/^[1-9]\d{9}$/u.test(international.selectedUid) ||
                  (!international.selectedUid && items.length === start))) {
                if (!session) {
                  items.push({ game, gameName: names[game], ok: false, error: "绝区零国际服便笺请从本人私聊查询。" });
                } else {
                  const verifyProfile = async () => {
                    active.throwIfAborted();
                    const latest = await profiles.internationalRoleContext(qq, id, "zzz").catch(() => undefined);
                    if (latest?.revision !== international.revision) throw new HoyoRequestError("profile-changed", changed);
                  };
                  try {
                    const note = await client.fetchHoYoLabZzzDailyNote(international, { signal: active, verifyProfile });
                    items.push(noteCardItem(note));
                    verifyDelivery.push(verifyProfile);
                  } catch (error) {
                    await verifyProfile();
                    items.push({ game, gameName: names[game], ok: false, error: failure(error) });
                  }
                }
              } else if (items.length === start && saved.some(source => source.game === game)) {
                items.push({ game, gameName: names[game], ok: false, error: "请绑定当前档案的 HoYoLAB 账号并选中绝区零国际服角色。" });
              }
            }
            if (items.length === start) items.push({ game, gameName: names[game], ok: false, error: "未同步 UID。" });
          }
        } catch (error) {
          if (active.aborted) return [];
          if ((error instanceof HoyoRequestError && error.code === "profile-changed") ||
              (error instanceof ProfileError && error.code === "changed")) {
            return changed;
          }
          items.push({ ok: false, error: failure(error) });
        }
        groups.push({ name: `Profile ${id}`, items });
      }

      const renderer = await import("@lotus-yunzai/skia/daily-note").catch(() => undefined);
      for (const page of pagesOf(groups)) {
        if (active.aborted) return [];
        let reply: MessageReply;
        try {
          const image = await renderer?.renderDailyNoteCard(page, { resourceDirectory: Bun.env.LOTUS_DAILY_NOTE_RESOURCES || undefined });
          reply = image ? { type: "image", file: image.png } : textReply(page.groups);
        } catch {
          reply = textReply(page.groups);
        }
        try {
          await Promise.all(verifyDelivery.map(verify => verify()));
        } catch {
          return active.aborted ? [] : changed;
        }
        if (active.aborted) return [];
        if (await context.reply(reply) === false) break;
      }
      return [];
    },
  };
}
