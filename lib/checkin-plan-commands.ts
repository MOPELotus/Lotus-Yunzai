import { createProfileStore } from "@lotus-yunzai/account";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { CheckinSchedulePlan } from "./checkin-schedule-plan.ts";
import type { createCheckinScheduleRuntime } from "./checkin-schedule-runtime.ts";
import type { CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";

export async function checkinPlanCard(plan: CheckinSchedulePlan, title: string, subtitle: string, signal: AbortSignal,
  extra: readonly string[] = []) {
  const lines = plan.entries.slice(0, 12).map(entry => `Profile ${entry.profileId}：${entry.time} · ${entry.mode}`);
  if (plan.entries.length > 12) lines.push(`更多：另有 ${plan.entries.length - 12} 个 profile`);
  lines.push(...extra);
  const message = plan.mode === "random"
    ? "随机模式已按时间窗口均匀分布，重启会复用已生成计划。"
    : "固定模式计划已生成，允许用户级随机的 profile 会单独分布。";
  const lead = `${subtitle}\n${message}`;
  if (signal.aborted) return "";
  try {
    const { png } = await renderStatusCard(title, lead, lines, new Date(),
      { themeDirectory: Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || undefined });
    if (signal.aborted) return "";
    if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
  } catch {
    // Return the same plan details as text if the old card cannot be drawn.
  }
  return signal.aborted ? "" : [title, lead, ...lines].join("\n");
}

export function checkinPlanCommands(profiles: Pick<ReturnType<typeof createProfileStore>, "listIds" | "checkinSettings">,
  schedule: Pick<ReturnType<typeof createCheckinScheduleRuntime>, "personalTomorrow">, signal: AbortSignal): CommandModule {
  return {
    name: "@lotus-yunzai/checkin-plan",
    commands: {
      async "#我的签到时间"(argument, context) {
        if (argument) return "请直接发送 #我的签到时间。";
        if (signal.aborted) return "";
        if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) return "请从 QQ 会话查看签到时间。";
        const qq = String(context.user_id);
        try {
          const targets = [];
          for (const profileId of await profiles.listIds(qq)) {
            if (signal.aborted) return "";
            const profile = await profiles.checkinSettings(qq, profileId).catch(() => undefined);
            if (profile?.enabled) targets.push({ qq, profileId, name: profile.displayName, enabled: true, schedule: profile.schedule });
          }
          const plan = await schedule.personalTomorrow(qq, targets);
          if (signal.aborted) return "";
          if (!plan) return "明日签到计划尚未生成，请等待计划生成任务。";
          if (!plan.entries.length) return "明日计划里没有找到你的 profile。";
          return checkinPlanCard(plan, "我的签到时间", `${plan.date} · QQ ${qq}`, signal);
        } catch {
          return signal.aborted ? "" : "明日签到计划暂时无法读取。";
        }
      },
    },
  };
}
