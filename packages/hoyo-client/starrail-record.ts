import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export async function readStarRailPersonalRecord(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal }, verifyProfile?: () => Promise<void>) {
  const { role } = source;
  if (source.game !== "sr" || role.gameBiz !== "hkrpg_cn" || !/^(?:prod_gf_cn|prod_qd_cn)$/u.test(role.region)) {
    throw new HoyoRequestError("invalid-input", $t("starrail-record.text_a3498c8358"));
  }
  const { data, region } = await readCnGameRecord(source, transport, { kind: "starrail-index", signal }, verifyProfile);
  for (const row of [data, data.role]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const fields = row as Record<string, unknown>;
    const wrongUid = ["uid", "role_id", "game_uid"].some(key => Object.hasOwn(fields, key) && String(fields[key]) !== role.uid);
    const wrongServer = ["region", "server"].some(key => Object.hasOwn(fields, key) && fields[key] !== region);
    if (wrongUid || wrongServer || (Object.hasOwn(fields, "game_biz") && fields.game_biz !== role.gameBiz)) {
      throw new HoyoRequestError("response", $t("starrail-record.text_3f0a1ec0e2"));
    }
  }
  return { data };
}
