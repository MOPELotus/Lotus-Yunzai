import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import type { CheckinScheduleProfile } from "./checkin-schedule-plan.ts";
import type { CommandContext, CommandModule, CommandReply } from "./commands.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";
import { checkinSettingsNickname } from "./checkin-profile-commands.ts";

const register = /^#注册自动签到([1-9]\d{0,2})?$/u;

export const checkinStatusCommand = "#签到状态";
export const unregisterCheckinCommand = "#删除签到";

interface CheckinSession {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

const domesticGames = [
  ["genshin", "原神"], ["honkai_sr", "星铁"], ["zzz", "绝区零"],
  ["honkai3rd", "崩坏3"], ["honkai2", "崩坏2"], ["tears_of_themis", "未定事件簿"],
] as const;

export function checkinStatus(directory: string | undefined) {
  const profiles = createProfileStore(directory);
  return async (qq: string, { isCurrent }: Pick<CheckinSession, "isCurrent">) => {
    let ids: number[];
    if (!isCurrent()) return;
    try {
      ids = await profiles.listIds(qq);
    } catch {
      if (isCurrent()) return "暂时无法读取本人的签到档案。";
      return;
    }
    let bound = 0;
    let unreadable = 0;
    const registered: string[] = [];
    for (const id of ids) {
      if (!isCurrent()) return;
      try {
        const { enabled, loggedIn, games, communityForums } = await profiles.checkinSettings(qq, id);
        if (loggedIn) bound++;
        if (!enabled) continue;
        const selected = domesticGames.filter(([game]) => games[game]?.enabled).map(([, name]) => name).join("、");
        const scopes = [selected || "无国服游戏", communityForums.length ? " + 社区" : "", loggedIn ? "" : "（待登录）"].join("");
        registered.push(`档案 ${id}：${scopes}`);
      } catch { unreadable++; }
    }
    if (!isCurrent()) return;
    if (unreadable && unreadable === ids.length) return "暂时无法读取本人的签到档案。";
    const lines = [`已绑定 ${bound} 个登录档案，已注册 ${registered.length} 个自动签到档案。`, ...registered];
    if (!bound) lines.push("尚无登录资料，可发送 #扫码登录。");
    else if (!registered.length) lines.push("尚未注册自动签到，可发送 #注册自动签到。");
    if (unreadable) lines.push(`另有 ${unreadable} 个档案暂时无法读取。`);
    return lines.join("\n");
  };
}

export function checkinUnregistration(directory: string | undefined, reconcilePlans: () => Promise<void>) {
  const profiles = createProfileStore(directory);
  return async (qq: string, { signal, isCurrent }: CheckinSession) => {
    let disabled = 0;
    let failed = 0;
    let ids: number[];
    if (!isCurrent()) return;
    try {
      ids = await profiles.listIds(qq);
    } catch {
      if (isCurrent()) return "暂时无法读取本人的签到档案。";
      return;
    }
    for (const id of ids) {
      if (!isCurrent()) break;
      try {
        const current = await profiles.checkinSettings(qq, id);
        if (!current.enabled) continue;
        if (!isCurrent()) break;
        const change = await profiles.setCheckinEnabled(qq, id, current.revision, false, signal, isCurrent);
        if (change.changed) disabled++;
      } catch (error) {
        if (!isCurrent()) break;
        if (!(error instanceof ProfileError && error.code === "missing")) failed++;
      }
    }
    let planPending = false;
    if (disabled) {
      try { await reconcilePlans(); }
      catch { planPending = true; }
    }
    if (!isCurrent()) return;
    if (!disabled) return failed ? "暂时无法关闭本人的自动签到，请重新发送指令。" : "未注册自动签到，无需关闭。";
    const lines = [`已关闭 ${disabled} 个档案的自动签到，登录资料已保留。`,
      "如需继续，请重新发送 #注册自动签到，其他档案按编号注册。"];
    if (failed) lines.push(`另有 ${failed} 个档案未能关闭，请重试。`);
    if (planPending) lines.push("签到计划将在下一轮重新检查。");
    return lines.join("\n");
  };
}

export function checkinRegistrationCommands(directory: string | undefined, signal: AbortSignal, {
  canRegister, addRegisteredProfile, viewProfile,
}: {
  readonly canRegister: (context: CommandContext) => boolean;
  readonly addRegisteredProfile: (profile: CheckinScheduleProfile) => Promise<void>;
  readonly viewProfile: (profileId: number, context: CommandContext) => CommandReply | Promise<CommandReply>;
}): CommandModule {
  const profiles = createProfileStore(directory);
  return {
    name: "@lotus-yunzai/checkin-registration", commands: {},
    async fallback(_message, context) {
      const match = register.exec(context.normalizedMessage);
      if (!match || signal.aborted) return;
      const profileId = Number(match[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) {
        return "请从对应的 QQ 会话注册自动签到。";
      }
      if (!canRegister({ ...context, isMaster: isCheckinCommandOwner(context) })) return "当前会话无权注册自动签到。";
      const qq = String(context.user_id);
      let saved = false;
      try {
        const state = await profiles.checkinSettings(qq, profileId);
        if (!state.loggedIn) return `请先登录档案 ${profileId}。`;
        if (signal.aborted) return;
        const updated = await profiles.setCheckinEnabled(qq, profileId, state.revision, true,
          signal, undefined, () => checkinSettingsNickname(context));
        saved = true;
        const current = await profiles.checkinSettings(qq, profileId);
        if (signal.aborted) return;
        if (current.revision !== updated.revision) return "档案设置已变化，请重新查看当前签到配置。";
        await addRegisteredProfile({ qq, profileId, name: current.displayName, enabled: current.enabled, schedule: current.schedule });
        if (signal.aborted) return;
        return viewProfile(profileId, context);
      } catch (error) {
        if (signal.aborted) return;
        if (saved) return `档案 ${profileId} 已注册，暂时无法更新本地签到计划或显示资料卡。`;
        if (error instanceof ProfileError && (error.code === "missing" || error.code === "login-required")) {
          return `请先登录档案 ${profileId}。`;
        }
        if (error instanceof ProfileError && error.code === "changed") return "档案设置已变化，请重新注册。";
        return "暂时无法注册自动签到。";
      }
    },
  };
}
