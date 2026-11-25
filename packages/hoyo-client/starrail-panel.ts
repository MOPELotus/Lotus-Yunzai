import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export interface StarRailPanelOptions {
  readonly signal?: AbortSignal;
}

type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

export async function readStarRailPanel(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: StarRailPanelOptions, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "starrail-avatar-info", signal }, verifyProfile);
  for (const record of [data, object(data.role)]) {
    for (const key of ["uid", "role_id", "game_uid"]) {
      if (record && Object.hasOwn(record, key) && String(record[key]) !== source.role.uid) {
        throw new HoyoRequestError("response", $t("starrail-panel.text_581178a173"));
      }
    }
    for (const key of ["region", "server"]) {
      if (record && Object.hasOwn(record, key) && record[key] !== region) {
        throw new HoyoRequestError("response", $t("starrail-panel.text_4f6f08a5ff"));
      }
    }
  }
  const avatars = data.avatar_list;
  if (!Array.isArray(avatars) || avatars.length > 256 || avatars.some(avatar => !object(avatar))) {
    throw new HoyoRequestError("response", $t("starrail-panel.text_800d70e129"));
  }
  return { avatars: avatars as Json[] };
}
