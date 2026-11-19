import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { createCheckinAudit } from "./checkin-audit.ts";
import type { CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";

const logTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function shortTime(time: string) {
  const parts = logTime.formatToParts(new Date(time));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "00";
  return `${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

export function checkinAuditCommands(audit: Pick<ReturnType<typeof createCheckinAudit>, "read">,
  signal: AbortSignal): CommandModule {
  return {
    name: "@lotus-yunzai/checkin-admin",
    commands: {
      async "#自动签到日志"(argument, context) {
        if (argument) return "请直接发送 #自动签到日志。";
        if (signal.aborted) return "";
        const qq = context.user_id;
        const owner = context.isMaster === true;
        if (!owner && (!qq || !Number.isSafeInteger(qq) || qq < 1)) return "请在对应的 QQ 会话查看签到日志。";
        try {
          const rows = await audit.read(owner ? { owner: true } : { qq: String(qq) });
          if (signal.aborted) return "";
          const title = "签到日志";
          const view = owner ? "最近全局记录" : `QQ ${qq}`;
          const message = rows.length ? `最近 ${rows.length} 条签到记录` : "暂无签到审计记录。";
          const lines = rows.map(row =>
            `${shortTime(row.time)} · P${row.profileId}\n${row.ok ? "成功" : "失败"} · ${row.stage} · QQ ${row.qq}`);
          try {
            const { png } = await renderStatusCard(title, `${view}\n${message}`, lines, new Date(),
              { themeDirectory: Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || undefined });
            if (signal.aborted) return "";
            if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
          } catch {
            // Return the projected rows if the local renderer is unavailable.
          }
          return signal.aborted ? "" : [title, view, message, ...lines].join("\n");
        } catch {
          return signal.aborted ? "" : "签到日志暂时无法读取。";
        }
      },
    },
  };
}
