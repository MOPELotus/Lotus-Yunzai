import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import { verifyRole } from "./genshin-panel.ts";

export interface GenshinHardChallengeOptions {
  readonly signal?: AbortSignal;
  readonly scheduleType: 1 | 2;
}

export async function readGenshinHardChallenge(source: ProfileRequestContext, transport: HoyoTransport,
  { signal, scheduleType }: GenshinHardChallengeOptions, verifyProfile?: () => Promise<void>) {
  if (scheduleType !== 1 && scheduleType !== 2) throw new HoyoRequestError("invalid-input", $t("genshin-hard-challenge.text_ccd9b77241"));
  const { data, region } = await readCnGameRecord(source, transport, { kind: "genshin-hard-challenge", signal }, verifyProfile);
  verifyRole(data, source.role.uid, region, $t("genshin-hard-challenge.text_c3354e0ec8"));
  if (!Array.isArray(data.data)) throw new HoyoRequestError("response", $t("genshin-hard-challenge.text_8e16b85d6c"));
  let skipEquipment = false;
  const current = data.data[0];
  const hasData = [current?.single?.has_data, current?.mp?.has_data].some(value => [true, 1, "1", "true"].includes(value));
  const popularity = scheduleType === 1 && hasData ? await readCnGameRecord(source, transport,
    { kind: "genshin-hard-popularity", signal }, verifyProfile).catch(error => {
      if (!(error instanceof HoyoRequestError) || error.code === "profile-changed" || signal?.aborted) throw error;
      skipEquipment = true;
      return undefined;
    }) : undefined;
  // The popularity route returns the current rotation. An optional request
  // error leaves the verified personal result available without any retries.
  signal?.throwIfAborted();
  await verifyProfile?.();
  const avatarIds: number[] = [];
  if (popularity) {
    const avatars = popularity.data.avatar_list;
    try { verifyRole(popularity.data, source.role.uid, region, $t("genshin-hard-challenge.text_a75ac03971")); }
    catch { return { challenge: data, avatarIds, skipEquipment: true }; }
    if (Array.isArray(avatars)) {
      for (const row of avatars.slice(0, 128)) {
        const raw = row?.avatar_id;
        const id = typeof raw === "string" && /^\d{1,9}$/u.test(raw) ? Number(raw) : raw;
        if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) avatarIds.push(id);
      }
    }
  }
  return { challenge: data, avatarIds, skipEquipment };
}
