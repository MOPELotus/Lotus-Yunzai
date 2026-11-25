import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { BbsCheckinRequestError, createProfileHoyoClient, HoyoRequestError } from "@lotus-yunzai/hoyo-client";

const command = /^#*(?:米游币|米币)查询([1-9]\d{0,2})?$/u;

export function miyousheBalanceProfile(message: string): number | undefined {
  const matched = command.exec(message.trim());
  return matched ? Number(matched[1] ?? 1) : undefined;
}

function balanceProblem(error: unknown) {
  if (error instanceof BbsCheckinRequestError) return ({
    "cookie-expired": $t("lib.miyoushe-balance.text_812bf0e4b5"),
    "login-expired": $t("lib.miyoushe-balance.text_10e461c670"),
    risk: $t("lib.miyoushe-balance.text_810c444061"),
    "rate-limited": $t("lib.miyoushe-balance.text_71fcc2c04b"),
  })[error.reason];
  if (error instanceof HoyoRequestError) {
    if (error.code === "profile-changed") return $t("lib.miyoushe-balance.text_3b35af4300");
    if (error.code === "refresh") return $t("lib.miyoushe-balance.text_e5f07e242e");
    if (error.code === "invalid-input") return $t("lib.miyoushe-balance.text_4876d661fa");
  }
  if (error instanceof ProfileError && (error.code === "missing" || error.code === "login-required")) {
    return $t("lib.miyoushe-balance.text_55a3500e39");
  }
  return $t("lib.miyoushe-balance.text_d5814fd93c");
}

export function createMiyousheBalanceQuery(directory: string | undefined, transport?: Parameters<typeof createProfileHoyoClient>[1]) {
  const profiles = createProfileStore(directory);
  const client = createProfileHoyoClient(profiles, transport);
  return async (userId: number, profileId: number, signal: AbortSignal): Promise<string | undefined> => {
    if (signal.aborted) return;
    if (profileId > MAX_PROFILE_ID) return $t("lib.miyoushe-balance.text_b4ba5fed47", { "MAX_PROFILE_ID": MAX_PROFILE_ID });
    const qq = String(userId);
    try {
      const source = await profiles.accountContext(qq, profileId);
      if (signal.aborted) return;
      const result = await client.fetchBbsMissionState(source, { signal, allowPointsOnly: true });
      const current = await profiles.accountContext(qq, profileId).catch(() => undefined);
      if (signal.aborted) return;
      if (current?.revision !== result.revision) return $t("lib.miyoushe-balance.text_3b35af4300");
      const rows = [
        $t("lib.miyoushe-balance.text_d80bcffa63", { "value1": result.totalPoints ?? $t("lib.miyoushe-balance.text_018d442e74") }),
        $t("lib.miyoushe-balance.text_a3f45a2a2d", { "value1": result.remainingPoints ?? $t("lib.miyoushe-balance.text_018d442e74") }),
      ];
      if (profileId !== 1) rows.unshift($t("lib.miyoushe-balance.text_3f6fdc79bb", { "profileId": profileId }));
      return rows.join("\n");
    } catch (error) {
      if (!signal.aborted) return balanceProblem(error);
    }
  };
}
