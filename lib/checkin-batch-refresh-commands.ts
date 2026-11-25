import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { ProfileError, type createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";

type Profiles = ReturnType<typeof createProfileStore>;

interface CheckinBatchRefreshOptions {
  readonly profiles: Profiles;
  readonly signal: AbortSignal;
  readonly makeClient?: (profiles: Profiles) => Pick<ReturnType<typeof createProfileHoyoClient>, "refreshProfile">;
  readonly render?: (...args: Parameters<typeof renderStatusCard>) => Promise<{ readonly png: Uint8Array }>;
}

const title = $t("lib.checkin-batch-refresh-commands.text_bb3ff4dce7");
const limit = 14;

function failure(error: unknown): string {
  if (error instanceof ProfileError) {
    if (error.code === "missing") return $t("lib.checkin-batch-refresh-commands.text_5c017a4eff");
    if (error.code === "login-required") return $t("lib.checkin-batch-refresh-commands.text_5905b88566");
    if (error.code === "changed") return $t("lib.checkin-batch-refresh-commands.text_397d0445a6");
  }
  if (error instanceof HoyoRequestError && error.code === "profile-changed") return $t("lib.checkin-batch-refresh-commands.text_397d0445a6");
  return $t("lib.checkin-batch-refresh-commands.text_0c65f98c62");
}

export function checkinBatchRefreshCommands({
  profiles, signal, makeClient = createProfileHoyoClient, render = renderStatusCard,
}: CheckinBatchRefreshOptions): CommandModule {
  const client = makeClient(profiles);
  let running = false;

  return {
    name: "@lotus-yunzai/checkin-batch-refresh", commands: {},
    async fallback(_message, context) {
      if (context.normalizedMessage !== "#批量刷新签到" || signal.aborted) return;
      if (!isCheckinCommandOwner(context)) return $t("lib.checkin-batch-refresh-commands.text_23000efce7");
      if (running) return $t("lib.checkin-batch-refresh-commands.text_c4641cd8db");
      running = true;
      try {
        try {
          await context.reply($t("lib.checkin-batch-refresh-commands.text_bd8bdf8a1b"));
        } catch {
          // The authorized request can proceed when the progress message cannot be delivered.
        }
        if (signal.aborted) return;
        const targets = await profiles.listCheckinProfiles();
        let refreshed = 0;
        let synced = 0;
        const contents: string[] = [];
        for (const { qq, profileId } of targets) {
          if (signal.aborted) return;
          let status: string;
          try {
            const account = await profiles.accountContext(qq, profileId);
            if (signal.aborted) return;
            const { rolesSynced } = await client.refreshProfile(account, signal);
            refreshed++;
            if (rolesSynced) synced++;
            status = rolesSynced ? $t("lib.checkin-batch-refresh-commands.text_83913e71fc") : $t("lib.checkin-batch-refresh-commands.text_09845c9870");
          } catch (error) {
            status = failure(error);
          }
          if (contents.length < limit) contents.push(`QQ ${qq} · P${profileId}：${status}`);
        }
        if (signal.aborted) return;
        const message = targets.length
          ? $t("lib.checkin-batch-refresh-commands.text_c5955319a3", { "synced": synced })
          : $t("lib.checkin-batch-refresh-commands.text_6efd775cb3");
        const lead = $t("lib.checkin-batch-refresh-commands.text_e5303c6f5b", { "refreshed": refreshed, "length": targets.length, "message": message });
        try {
          const { png } = await render(title, lead, contents, new Date(), {
            themeDirectory: Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || undefined, timeZone: "Asia/Shanghai",
          });
          if (signal.aborted) return;
          if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
        } catch {
          // Render and text output cover the same batch results.
        }
        if (!signal.aborted) return [title, lead, ...contents].join("\n");
      } catch {
        if (!signal.aborted) return $t("lib.checkin-batch-refresh-commands.text_7179e531db");
      } finally {
        running = false;
      }
    },
  };
}
