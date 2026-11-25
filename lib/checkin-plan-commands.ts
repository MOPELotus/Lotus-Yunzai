import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
      const detail = change.type === "plan-cron" ? $t("lib.checkin-plan-commands.text_b9b27cc3c7")
        : change.mode === "random" ? $t("lib.checkin-plan-commands.text_180649a6c5") : $t("lib.checkin-plan-commands.text_11432f0666");
      return statusMessage($t("lib.checkin-plan-commands.text_206dcbaaf0"), $t("lib.checkin-plan-commands.text_74d664b76d", { "detail": detail }), [
        $t("lib.checkin-plan-commands.text_b9bac5ac4e", { "value1": saved.mode ?? "random" }), $t("lib.checkin-plan-commands.text_a13cfc6e94", { "value1": saved.fixed_time ?? "04:30" }),
        $t("lib.checkin-plan-commands.text_4fa3db84b0", { "value1": saved.plan_generate_cron ?? "0 0 0 * * ? *" }), $t("lib.checkin-plan-commands.text_92dd7446df", { "value1": saved.run_due_cron ?? "0 * * * * *" }),
      ], signal);
    } catch (error) {
      if (signal.aborted) return "";
      return error instanceof CheckinScheduleSettingsError ? error.message : $t("lib.checkin-plan-commands.text_4e291fb36a");
    }
  }
  return {
    name: "@lotus-yunzai/checkin-schedule-settings",
    commands: {
      "#签到随机模式"(argument, context) {
        return argument ? $t("lib.checkin-plan-commands.text_8dd280b33c") : save(context, { type: "mode", mode: "random" });
      },
      "#签到固定模式"(argument, context) {
        return save(context, { type: "mode", mode: "fixed", ...(argument && { time: argument }) });
      },
      "#签到计划生成"(argument, context) {
        return argument ? save(context, { type: "plan-cron", time: argument }) : $t("lib.checkin-plan-commands.text_84152f12f4");
      },
    },
  };
}

function checkinPlanCard(plan: CheckinSchedulePlan, title: string, subtitle: string, signal: AbortSignal, extra: readonly string[] = []) {
  const lines = plan.entries.slice(0, 12).map(entry =>
    $t("lib.checkin-plan-commands.text_375a4fcb27", { "profileId": entry.profileId, "time": entry.time, "value3": entry.stage === legacyUnconfirmedStage ? $t("lib.checkin-plan-commands.text_5a1a607119") : entry.mode }));
  if (plan.entries.length > 12) lines.push($t("lib.checkin-plan-commands.text_f5130a3a8a", { "value1": plan.entries.length - 12 }));
  lines.push(...extra);
  const message = plan.mode === "random"
    ? $t("lib.checkin-plan-commands.text_9887346e5c")
    : $t("lib.checkin-plan-commands.text_93593e0a29");
  return statusMessage(title, `${subtitle}\n${message}`, lines, signal);
}

export function checkinPlanNotice(entry: CheckinScheduleEntry, date: string, title: string, late: boolean, signal: AbortSignal) {
  const message = late ? $t("lib.checkin-plan-commands.text_245c3e0430", { "time": entry.time }) :
    $t("lib.checkin-plan-commands.text_61fab5f807", { "time": entry.time });
  return statusMessage(title, $t("lib.checkin-plan-commands.text_ad055e9d82", { "date": date, "profileId": entry.profileId, "message": message }), [
    $t("lib.checkin-plan-commands.text_0e8398152b", { "time": entry.time }), $t("lib.checkin-plan-commands.text_b9bac5ac4e", { "value1": late ? $t("lib.checkin-plan-commands.text_56c9660971") : entry.mode }), $t("lib.checkin-plan-commands.text_80811a4645", { "date": date }),
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
        if (argument) return $t("lib.checkin-plan-commands.text_db8f60aa57");
        if (signal.aborted) return "";
        if (!permission.canGenerate(context)) return $t("lib.checkin-plan-commands.text_446c916ec9");
        try {
          const next = await schedule.generateTomorrow();
          if (signal.aborted) return "";
          if (!next) return $t("lib.checkin-plan-commands.text_80c26ead54");
          const counts = next.notices;
          return checkinPlanCard(next.plan, $t("lib.checkin-plan-commands.text_8d5f5be591"), $t("lib.checkin-plan-commands.text_07f0de5d5c", { "date": next.plan.date }), signal,
            counts ? [$t("lib.checkin-plan-commands.text_3900c70e87", { "confirmed": counts.confirmed, "length": next.plan.entries.length })] : []);
        } catch {
          return signal.aborted ? "" : $t("lib.checkin-plan-commands.text_b2672c7c39");
        }
      },
      async "#执行到期签到"(argument, context) {
        if (argument) return $t("lib.checkin-plan-commands.text_9831ddeae2");
        if (signal.aborted) return "";
        if (!permission.canRunDue(context)) return $t("lib.checkin-plan-commands.text_0deec12361");
        if (!schedule.enabled) return $t("lib.checkin-plan-commands.text_9b30689e7c");
        try { await context.reply?.($t("lib.checkin-plan-commands.text_c04ddeae0d")); } catch { /* Keep the authorized scan running. */ }
        if (signal.aborted) return "";
        if (!permission.canRunDue(context)) return $t("lib.checkin-plan-commands.text_0deec12361");
        const result = await schedule.runDue();
        if (signal.aborted) return "";
        if (result?.status === "failed") return $t("lib.checkin-plan-commands.text_925bbe2f72");
        if (result?.status === "locked") return $t("lib.checkin-plan-commands.text_bc2dc21766");
        if (!result) return $t("lib.checkin-plan-commands.text_01c0d3274d");
        const message = result.status === "interrupted" ? $t("lib.checkin-plan-commands.text_cf5ce1c229") : result.entries.length
          ? $t("lib.checkin-plan-commands.text_22ff848bda") : $t("lib.checkin-plan-commands.text_01c0d3274d");
        const lines = result.entries.slice(0, 8).map(entry =>
          `QQ ${entry.qq} · P${entry.profileId}：${entry.communityRetry ? $t("lib.checkin-plan-commands.text_436805db16") : entry.ok ? $t("lib.checkin-plan-commands.text_053461ce86") : $t("lib.checkin-plan-commands.text_28384d7afd")} · ${entry.stage}`);
        if (result.deferred) lines.push($t("lib.checkin-plan-commands.text_149a8b1518", { "deferred": result.deferred }));
        return statusMessage($t("lib.checkin-plan-commands.text_f988617878"), `${result.date}\n${message}`, lines, signal);
      },
      async "#我的签到时间"(argument, context) {
        if (argument) return $t("lib.checkin-plan-commands.text_4f55fe9f28");
        if (signal.aborted) return "";
        if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) return $t("lib.checkin-plan-commands.text_57ba35cda5");
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
          if (!plan) return $t("lib.checkin-plan-commands.text_0cb3994d71");
          if (!plan.entries.length) return $t("lib.checkin-plan-commands.text_aa4d086a82");
          return checkinPlanCard(plan, $t("lib.checkin-plan-commands.text_013360cfe8"), `${plan.date} · QQ ${qq}`, signal);
        } catch {
          return signal.aborted ? "" : $t("lib.checkin-plan-commands.text_d2d2351a0a");
        }
      },
    },
  };
}
