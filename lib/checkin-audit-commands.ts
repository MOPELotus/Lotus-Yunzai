import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { createCheckinAudit } from "./checkin-audit.ts";
import type { CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";

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
        if (argument) return $t("lib.checkin-audit-commands.text_007e8d6b13");
        if (signal.aborted) return "";
        const qq = context.user_id;
        const owner = isCheckinCommandOwner(context);
        if (!owner && (!qq || !Number.isSafeInteger(qq) || qq < 1)) return $t("lib.checkin-audit-commands.text_67fa434f1a");
        try {
          const rows = await audit.read(owner ? { owner: true } : { qq: String(qq) });
          if (signal.aborted) return "";
          const title = $t("lib.checkin-audit-commands.text_48a0ef8b37");
          const view = owner ? $t("lib.checkin-audit-commands.text_6327e152b9") : `QQ ${qq}`;
          const message = rows.length ? $t("lib.checkin-audit-commands.text_2da407c844", { "length": rows.length }) : $t("lib.checkin-audit-commands.text_2cfa9578bd");
          const lines = rows.map(row =>
            `${shortTime(row.time)} · P${row.profileId}
${row.ok ? $t("lib.checkin-audit-commands.text_053461ce86") : $t("lib.checkin-audit-commands.text_28384d7afd")} · ${row.stage} · QQ ${row.qq}`);
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
          return signal.aborted ? "" : $t("lib.checkin-audit-commands.text_965fe57f2d");
        }
      },
    },
  };
}
