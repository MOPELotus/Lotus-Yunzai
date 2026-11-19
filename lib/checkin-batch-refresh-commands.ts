import { ProfileError, type createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";

type Profiles = ReturnType<typeof createProfileStore>;

interface CheckinBatchRefreshOptions {
  readonly profiles: Profiles;
  readonly signal: AbortSignal;
  readonly makeClient?: (profiles: Profiles) => Pick<ReturnType<typeof createProfileHoyoClient>, "refreshProfile">;
  readonly render?: (...args: Parameters<typeof renderStatusCard>) => Promise<{ readonly png: Uint8Array }>;
}

const title = "批量刷新";
const limit = 14;

function failure(error: unknown): string {
  if (error instanceof ProfileError) {
    if (error.code === "missing") return "档案已不存在";
    if (error.code === "login-required") return "档案尚未登录";
    if (error.code === "changed") return "档案已变化";
  }
  if (error instanceof HoyoRequestError && error.code === "profile-changed") return "档案已变化";
  return "刷新失败，请核对登录状态";
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
      if (context.isMaster !== true) return "只有 bot 主人可以批量刷新签到账号。";
      if (running) return "签到账号正在批量刷新，请稍后。";
      running = true;
      try {
        try {
          await context.reply("正在批量刷新全部 profile 登录信息。");
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
            status = rolesSynced ? "刷新成功" : "Cookie 已刷新，角色暂未同步";
          } catch (error) {
            status = failure(error);
          }
          if (contents.length < limit) contents.push(`QQ ${qq} · P${profileId}：${status}`);
        }
        if (signal.aborted) return;
        const message = targets.length
          ? `已按 profile 刷新登录信息，角色已同步 ${synced} 个档案。`
          : "暂无可刷新的档案。";
        const lead = `Lotus-Yunzai 档案 · Cookie 已刷新 ${refreshed}/${targets.length}\n${message}`;
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
        if (!signal.aborted) return "签到档案暂时无法读取。";
      } finally {
        running = false;
      }
    },
  };
}
