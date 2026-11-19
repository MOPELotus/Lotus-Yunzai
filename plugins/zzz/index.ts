import { fileURLToPath } from "node:url";
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError, ZzzTuningRateLimitError } from "@lotus-yunzai/hoyo-client";
import { renderZzzTuningFailure, renderZzzTuningResult } from "./tuning-result-card.ts";
import { createZzzTuningSync, ZzzTuningHistoryChangedError } from "./tuning-sync.ts";

const updateCommand = /^#绝区零(?:更新|刷新)抽卡(?:记录|链接)?([1-9]\d{0,2})?$/u;
const romanPrefix = /^#?zzz(?=(?:更新|刷新)抽卡)/iu;
const historyDirectory = fileURLToPath(new URL("../../data/zzzTuningStats/", import.meta.url));

interface GachaContext {
  readonly normalizedMessage: string;
  readonly user_id?: number;
  reply(message: string): unknown;
}

export function createModule({ signal, lockFile }: {
  signal: AbortSignal;
  lockFile: Parameters<typeof createZzzTuningSync>[3];
}) {
  const profiles = createProfileStore(Bun.env.LOTUS_PROFILE_DIR || undefined);
  const sync = createZzzTuningSync(profiles, createProfileHoyoClient(profiles), historyDirectory, lockFile);
  const updating = new Set<string>();

  return {
    commands: {},
    async fallback(_message: string, context: GachaContext) {
      const matched = updateCommand.exec(context.normalizedMessage.replace(romanPrefix, "#绝区零"));
      if (!matched) return;
      const profileId = Number(matched[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
        return "请从登录档案对应的 QQ 会话更新绝区零抽卡记录。";
      }
      const qq = String(user_id);
      const key = `${qq}/${profileId}`;
      if (updating.has(key)) return "该档案的绝区零抽卡记录正在更新，请稍后再试。";
      updating.add(key);
      try {
        await context.reply(`[荷花插件]正在为 profile ${profileId} 更新绝区零抽卡记录。`);
        const result = await sync.sync(qq, profileId, { signal });
        try {
          const { png } = await renderZzzTuningResult(qq, result);
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]绝区零抽卡记录更新完成。";
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ZzzTuningHistoryChangedError) return "该角色的绝区零抽卡记录已由另一条请求更新。";
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") return `[荷花插件]请先登录 profile ${profileId}。`;
          if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步绝区零 UID。`;
        }
        const reason = error instanceof ZzzTuningRateLimitError ? "rate-limited"
          : (error instanceof ProfileError && error.code === "changed") ||
            (error instanceof HoyoRequestError && error.code === "profile-changed") ? "profile-changed" : "request-failed";
        try {
          const { png } = await renderZzzTuningFailure({ qq, profileId, reason });
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]绝区零抽卡记录更新失败，请检查档案登录状态与绝区零 UID。";
        }
      } finally {
        updating.delete(key);
      }
    },
  };
}
