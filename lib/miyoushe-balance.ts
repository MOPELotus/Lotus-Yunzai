import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { BbsCheckinRequestError, createProfileHoyoClient, HoyoRequestError } from "@lotus-yunzai/hoyo-client";

const command = /^#*(?:米游币|米币)查询([1-9]\d{0,2})?$/u;

export function miyousheBalanceProfile(message: string): number | undefined {
  const matched = command.exec(message.trim());
  return matched ? Number(matched[1] ?? 1) : undefined;
}

function balanceProblem(error: unknown) {
  if (error instanceof BbsCheckinRequestError) return ({
    "cookie-expired": "当前档案的 Cookie 已过期，请重新登录后重试。",
    "login-expired": "当前档案的登录已过期，请重新登录后重试。",
    risk: "请在米游社官方客户端完成验证后重试。",
    "rate-limited": "米游币查询过于频繁，请稍后重试。",
  })[error.reason];
  if (error instanceof HoyoRequestError) {
    if (error.code === "profile-changed") return "档案已变更，请重新查询米游币。";
    if (error.code === "refresh") return "无法刷新当前档案的 Cookie，请确认登录状态后重试。";
    if (error.code === "invalid-input") return "当前档案的登录资料不一致，请重新登录后重试。";
  }
  if (error instanceof ProfileError && (error.code === "missing" || error.code === "login-required")) {
    return "当前档案尚未登录，请扫码登录后重试。";
  }
  return "暂时无法读取米游币余额，请稍后重试。";
}

export function createMiyousheBalanceQuery(directory: string | undefined, transport?: Parameters<typeof createProfileHoyoClient>[1]) {
  const profiles = createProfileStore(directory);
  const client = createProfileHoyoClient(profiles, transport);
  return async (userId: number, profileId: number, signal: AbortSignal): Promise<string | undefined> => {
    if (signal.aborted) return;
    if (profileId > MAX_PROFILE_ID) return `档案编号须在 1 到 ${MAX_PROFILE_ID} 之间。`;
    const qq = String(userId);
    try {
      const source = await profiles.accountContext(qq, profileId);
      if (signal.aborted) return;
      const result = await client.fetchBbsMissionState(source, { signal });
      const current = await profiles.accountContext(qq, profileId).catch(() => undefined);
      if (signal.aborted) return;
      if (current?.revision !== result.revision) return "档案已变更，请重新查询米游币。";
      const rows = [
        `当前米游币数量为：${result.totalPoints ?? "暂未返回"}`,
        `今日剩余可获取：${result.remainingPoints ?? "暂未返回"}`,
      ];
      if (profileId !== 1) rows.unshift(`档案 ${profileId}`);
      return rows.join("\n");
    } catch (error) {
      if (!signal.aborted) return balanceProblem(error);
    }
  };
}
