import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import type { CheckinScheduleProfile } from "./checkin-schedule-plan.ts";
import type { CommandContext, CommandModule, CommandReply } from "./commands.ts";

const register = /^#注册自动签到([1-9]\d{0,2})?$/u;

export const unregisterCheckinCommand = "#删除签到";

export function checkinUnregistration(directory: string | undefined, reconcilePlans: () => Promise<void>) {
  const profiles = createProfileStore(directory);
  return async (qq: string, signal: AbortSignal) => {
    let disabled = 0;
    let failed = 0;
    let ids: number[];
    try {
      signal.throwIfAborted();
      ids = await profiles.listIds(qq);
    } catch {
      if (!signal.aborted) return "暂时无法读取本人的签到档案。";
      return;
    }
    for (const id of ids) {
      if (signal.aborted) break;
      try {
        const current = await profiles.checkinSettings(qq, id);
        if (!current.enabled) continue;
        const change = await profiles.setCheckinEnabled(qq, id, current.revision, false, signal);
        if (change.changed) disabled++;
      } catch (error) {
        if (signal.aborted) break;
        if (!(error instanceof ProfileError && error.code === "missing")) failed++;
      }
    }
    let planPending = false;
    if (disabled) {
      try { await reconcilePlans(); }
      catch { planPending = true; }
    }
    if (signal.aborted) return;
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
      if (!canRegister(context)) return "当前会话无权注册自动签到。";
      const qq = String(context.user_id);
      let saved = false;
      try {
        const state = await profiles.checkinSettings(qq, profileId);
        if (!state.loggedIn) return `请先登录 profile ${profileId}。`;
        if (signal.aborted) return;
        const updated = await profiles.setCheckinEnabled(qq, profileId, state.revision, true);
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
          return `请先登录 profile ${profileId}。`;
        }
        if (error instanceof ProfileError && error.code === "changed") return "档案设置已变化，请重新注册。";
        return "暂时无法注册自动签到。";
      }
    },
  };
}
