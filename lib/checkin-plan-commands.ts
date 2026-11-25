import { createProfileStore } from "@lotus-yunzai/account";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import { legacyUnconfirmedStage, type CheckinScheduleEntry, type CheckinSchedulePlan } from "./checkin-schedule-plan.ts";
import type { createCheckinScheduleRuntime } from "./checkin-schedule-runtime.ts";
import { CheckinScheduleSettingsError, persistCheckinScheduleSettings, type CheckinScheduleSettingsChange } from "./checkin-schedule-settings.ts";
import type { CommandContext, CommandModule } from "./commands.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";
import { segment } from "./messages.ts";
import { accountScopePermission } from "./permissions.ts";

async function statusMessage(title: string, lead: string, lines: readonly string[], signal: AbortSignal) {
  if (signal.aborted) return "";
  try {
    const { png } = await renderStatusCard(title, lead, lines, new Date(),
      { themeDirectory: Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || undefined, timeZone: "Asia/Shanghai" });
    if (signal.aborted) return "";
    if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
  } catch {
    // Return the same plan details as text if the old card cannot be drawn.
  }
  return signal.aborted ? "" : [title, lead, ...lines].join("\n");
}

export function checkinScheduleSettingCommands(root: URL,
  runtime: Pick<ReturnType<typeof createCheckinScheduleRuntime>, "updateConfig">, signal: AbortSignal): CommandModule {
  let writing = Promise.resolve();
  async function save(context: CommandContext, change: CheckinScheduleSettingsChange) {
    if (signal.aborted) return "";
    const next = writing.then(async () => {
      const config = await persistCheckinScheduleSettings(root, change, {
        signal, canWrite: document => accountScopePermission(document, "scheduler.manage")({
          ...context, isMaster: isCheckinCommandOwner(context),
        }),
      });
      if (!signal.aborted) runtime.updateConfig(config);
      return config;
    });
    writing = next.then(() => {}, () => {});
    try {
      const saved = await next;
      const detail = change.type === "plan-cron" ? "已更新明日签到计划生成时间。"
        : change.mode === "random" ? "全局签到已切换到随机模式。" : "全局签到已切换到固定模式。";
      return statusMessage("调度配置", `Lotus-Yunzai 调度 · 已保存\n${detail}`, [
        `模式：${saved.mode ?? "random"}`, `固定时间：${saved.fixed_time ?? "04:30"}`,
        `计划生成：${saved.plan_generate_cron ?? "0 0 0 * * ? *"}`, `到期扫描：${saved.run_due_cron ?? "0 * * * * *"}`,
      ], signal);
    } catch (error) {
      if (signal.aborted) return "";
      return error instanceof CheckinScheduleSettingsError ? error.message : "暂时无法保存全局签到调度。";
    }
  }
  return {
    name: "@lotus-yunzai/checkin-schedule-settings",
    commands: {
      "#签到随机模式"(argument, context) {
        return argument ? "请直接发送 #签到随机模式。" : save(context, { type: "mode", mode: "random" });
      },
      "#签到固定模式"(argument, context) {
        return save(context, { type: "mode", mode: "fixed", ...(argument && { time: argument }) });
      },
      "#签到计划生成"(argument, context) {
        return argument ? save(context, { type: "plan-cron", time: argument }) : "请发送 #签到计划生成 H:MM。";
      },
    },
  };
}

function checkinPlanCard(plan: CheckinSchedulePlan, title: string, subtitle: string, signal: AbortSignal, extra: readonly string[] = []) {
  const lines = plan.entries.slice(0, 12).map(entry =>
    `档案 ${entry.profileId}：${entry.time} · ${entry.stage === legacyUnconfirmedStage ? "旧版签到结果待核对" : entry.mode}`);
  if (plan.entries.length > 12) lines.push(`另有 ${plan.entries.length - 12} 个档案`);
  lines.push(...extra);
  const message = plan.mode === "random"
    ? "随机模式已按时间窗口均匀分布，重启会复用已生成计划。"
    : "固定签到计划已生成，单独设置随机模式的档案按随机时间执行。";
  return statusMessage(title, `${subtitle}\n${message}`, lines, signal);
}

export function checkinPlanNotice(entry: CheckinScheduleEntry, date: string, title: string, late: boolean, signal: AbortSignal) {
  const message = late ? `新注册档案已补入签到计划，预计 ${entry.time} 左右执行。` :
    `明日自动签到将在 ${entry.time} 左右执行。`;
  return statusMessage(title, `${date} · 档案 ${entry.profileId}\n${message}`, [
    `签到时间：${entry.time}`, `模式：${late ? "新注册补位" : entry.mode}`, `日期：${date}`,
  ], signal);
}

export function checkinPlanCommands(profiles: Pick<ReturnType<typeof createProfileStore>, "listIds" | "checkinSettings">,
  schedule: Pick<ReturnType<typeof createCheckinScheduleRuntime>, "personalTomorrow" | "generateTomorrow" | "runDue" | "enabled">,
  signal: AbortSignal, permission: {
    readonly canGenerate: (context: CommandContext) => boolean;
    readonly canRunDue: (context: CommandContext) => boolean;
  }): CommandModule {
  return {
    name: "@lotus-yunzai/checkin-plan",
    commands: {
      async "#生成签到计划"(argument, context) {
        if (argument) return "请直接发送 #生成签到计划。";
        if (signal.aborted) return "";
        if (!permission.canGenerate(context)) return "当前会话无权生成全局签到计划。";
        try {
          const next = await schedule.generateTomorrow();
          if (signal.aborted) return "";
          if (!next) return "签到日期已切换，请重新生成计划。";
          const counts = next.notices;
          return checkinPlanCard(next.plan, "签到计划", `${next.plan.date} · 全局计划`, signal,
            counts ? [`已通知：${counts.confirmed}/${next.plan.entries.length}`] : []);
        } catch {
          return signal.aborted ? "" : "明日签到计划暂时无法生成。";
        }
      },
      async "#执行到期签到"(argument, context) {
        if (argument) return "请直接发送 #执行到期签到。";
        if (signal.aborted) return "";
        if (!permission.canRunDue(context)) return "当前会话无权执行到期签到。";
        if (!schedule.enabled) return "全局自动签到已关闭。";
        try { await context.reply?.("正在检查并执行到期签到任务。"); } catch { /* Keep the authorized scan running. */ }
        if (signal.aborted) return "";
        if (!permission.canRunDue(context)) return "当前会话无权执行到期签到。";
        const result = await schedule.runDue();
        if (signal.aborted) return "";
        if (result?.status === "failed") return "本轮到期签到暂时无法执行。";
        if (result?.status === "locked") return "到期签到正在执行，请稍后。";
        if (!result) return "当前没有到期且未完成的签到任务。";
        const message = result.status === "interrupted" ? "本轮中止，已确认的任务保留结果。" : result.entries.length
          ? "本轮到期签到已处理，结果按档案设置通知。" : "当前没有到期且未完成的签到任务。";
        const lines = result.entries.slice(0, 8).map(entry =>
          `QQ ${entry.qq} · P${entry.profileId}：${entry.communityRetry ? "已安排签到补跑" : entry.ok ? "成功" : "失败"} · ${entry.stage}`);
        if (result.deferred) lines.push(`稍后处理：${result.deferred} 个档案`);
        return statusMessage("到期签到", `${result.date}\n${message}`, lines, signal);
      },
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
          if (!plan.entries.length) return "明日计划里没有找到本人的档案。";
          return checkinPlanCard(plan, "我的签到时间", `${plan.date} · QQ ${qq}`, signal);
        } catch {
          return signal.aborted ? "" : "明日签到计划暂时无法读取。";
        }
      },
    },
  };
}
