import { ProfileError, type createProfileStore } from "@lotus-yunzai/account";
import type { createHoyoClient, GenshinGachaOptions } from "@lotus-yunzai/hoyo-client";
import type { createGenshinGachaHistoryStore } from "./gacha-store.ts";

export function createGenshinGachaSync(
  profiles: Pick<ReturnType<typeof createProfileStore>, "requestContext">,
  client: Pick<ReturnType<typeof createHoyoClient>, "fetchGenshinGacha">,
  history: ReturnType<typeof createGenshinGachaHistoryStore>,
) {
  return {
    async sync(qq: string, profileId = 1, options: GenshinGachaOptions = {}) {
      const original = await profiles.requestContext(qq, profileId, "gs");
      const uid = original.role.uid;
      const latest = await client.fetchGenshinGacha(original, options);
      if (latest.uid !== uid) throw new Error("原神抽卡快照与请求角色不一致。");

      async function verifyProfile() {
        options.signal?.throwIfAborted();
        const current = await profiles.requestContext(qq, profileId, "gs", uid).catch(() => undefined);
        if (current?.revision !== latest.revision || current?.role.uid !== uid) {
          throw new ProfileError("changed", "保存原神抽卡历史时档案已变更，请重新发起请求。");
        }
        options.signal?.throwIfAborted();
      }

      const result = await history.merge({ qq, uid }, latest, verifyProfile);
      return { ...result, profileId, refreshedCookie: latest.refreshedCookie };
    },
  };
}
