import { fileURLToPath } from "node:url";
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { renderGenshinGachaFailure, renderGenshinGachaResult } from "./gacha-result-card.ts";
import { createGenshinGachaHistoryStore } from "./gacha-store.ts";
import { createGenshinGachaSync } from "./gacha-sync.ts";

const updateCommand = /^#(?:原神)?更新抽卡记录([1-9]\d{0,2})?$/u;
const historyDirectory = fileURLToPath(new URL("../../data/gachaJson/", import.meta.url));

interface GachaContext {
  readonly normalizedMessage: string;
  readonly user_id?: number;
  reply(message: string): unknown;
}

export function createModule({ signal, lockFile }: {
  signal: AbortSignal;
  lockFile: Parameters<typeof createGenshinGachaHistoryStore>[1];
}) {
  const profiles = createProfileStore(Bun.env.LOTUS_PROFILE_DIR || undefined);
  const history = createGenshinGachaHistoryStore(historyDirectory, lockFile);
  const sync = createGenshinGachaSync(profiles, createProfileHoyoClient(profiles), history);
  const updating = new Set<string>();

  return {
    commands: {},
    async fallback(_message: string, context: GachaContext) {
      const matched = updateCommand.exec(context.normalizedMessage);
      if (!matched) return;
      const profileId = Number(matched[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
        return "请从登录档案对应的 QQ 会话更新原神抽卡记录。";
      }
      const qq = String(user_id);
      const key = `${qq}/${profileId}`;
      if (updating.has(key)) return "该档案的原神抽卡记录正在更新，请稍后再试。";
      updating.add(key);
      try {
        await context.reply(`[荷花插件]正在更新 Profile ${profileId} 的抽卡记录，会补齐官方范围内的缺档。`);
        const result = await sync.sync(qq, profileId, { signal });
        try {
          const { png } = await renderGenshinGachaResult(qq, result);
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]抽卡记录更新完成。";
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") return `[荷花插件]请先登录 profile ${profileId}。`;
          if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步原神 UID。`;
        }
        const reason = error instanceof HoyoRequestError && error.status === 429 ? "rate-limited"
          : (error instanceof ProfileError && error.code === "changed") ||
            (error instanceof HoyoRequestError && error.code === "profile-changed") ? "profile-changed" : "request-failed";
        try {
          const { png } = await renderGenshinGachaFailure({ qq, profileId, reason });
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]抽卡记录更新失败，请检查档案登录状态与原神 UID。";
        }
      } finally {
        updating.delete(key);
      }
    },
  };
}
