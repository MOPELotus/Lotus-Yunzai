import { fileURLToPath } from "node:url";
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { renderStarRailGachaFailure, renderStarRailGachaResult } from "./gacha-result-card.ts";
import { createStarRailGachaHistoryStore } from "./gacha-store.ts";
import { createStarRailGachaSync } from "./gacha-sync.ts";

const updateCommand = /^#星铁更新抽卡记录([1-9]\d{0,2})?$/u;
const historyRoot = fileURLToPath(new URL("../../data/starRailGachaJson/", import.meta.url));

interface UpdateContext {
  readonly normalizedMessage: string;
  readonly user_id?: number;
  reply(message: string): unknown;
}

export function createModule({ signal, lockFile }: {
  signal: AbortSignal;
  lockFile: Parameters<typeof createStarRailGachaHistoryStore>[1];
}) {
  const profiles = createProfileStore(Bun.env.LOTUS_PROFILE_DIR || undefined);
  const client = createProfileHoyoClient(profiles);
  const history = createStarRailGachaHistoryStore(historyRoot, lockFile);
  const service = createStarRailGachaSync(profiles, client, history);
  const active = new Set<string>();
  return {
    commands: {},
    async fallback(_message: string, context: UpdateContext) {
      const matched = updateCommand.exec(context.normalizedMessage);
      if (!matched) return;
      const profileId = Number(matched[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
        return "请从登录档案对应的 QQ 会话更新星铁抽卡记录。";
      }
      const qq = String(user_id);
      const key = `${qq}/${profileId}`;
      if (active.has(key)) return "该档案的星铁抽卡记录正在更新，请稍后再试。";
      active.add(key);
      try {
        await context.reply(`[荷花插件]正在为 profile ${profileId} 补齐官方范围内的星铁五星与垫抽记录。`);
        const result = await service.sync(qq, profileId, { signal });
        try {
          const { png } = await renderStarRailGachaResult(result);
          return { type: "image" as const, file: png };
        } catch {
          return `[荷花插件]星铁抽卡记录更新完成，新增 ${result.added} 条五星记录。`;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") {
            return `[荷花插件]请先登录 profile ${profileId}。`;
          }
          if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步星铁 UID。`;
        }
        const reason = error instanceof HoyoRequestError && error.status === 429 ? "rate-limited"
          : (error instanceof ProfileError && error.code === "changed") ||
            (error instanceof HoyoRequestError && error.code === "profile-changed") ? "profile-changed" : "request-failed";
        try {
          const { png } = await renderStarRailGachaFailure({ qq, profileId, reason });
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]星铁抽卡记录更新失败，请检查档案登录状态与星铁 UID。";
        }
      } finally {
        active.delete(key);
      }
    },
  };
}
