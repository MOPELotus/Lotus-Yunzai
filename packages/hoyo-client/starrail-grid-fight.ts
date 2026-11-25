import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export type StarRailGridFightOptions = { readonly signal?: AbortSignal };

type RecordData = Record<string, unknown>;

function object(value: unknown): RecordData | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as RecordData;
}

export async function readStarRailGridFight(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: StarRailGridFightOptions, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "starrail-grid-fight", signal }, verifyProfile);
  const brief = object(data.grid_fight_brief);
  const rows = data.grid_fight_archive_list;
  for (const identity of [data, object(data.role), brief]) {
    if (!identity) continue;
    if (["uid", "role_id", "game_uid"].some(key => Object.hasOwn(identity, key) && String(identity[key]) !== source.role.uid) ||
        ["region", "server"].some(key => Object.hasOwn(identity, key) && identity[key] !== region) ||
        (Object.hasOwn(identity, "game_biz") && identity.game_biz !== source.role.gameBiz)) {
      throw new HoyoRequestError("response", $t("starrail-grid-fight.text_f17aa157af"));
    }
  }
  if ((data.grid_fight_brief != null && !brief) ||
      (rows != null && (!Array.isArray(rows) || rows.length > 64 || rows.some(entry => !object(entry)))) ||
      (!brief && Array.isArray(rows) && rows.length)) {
    throw new HoyoRequestError("response", $t("starrail-grid-fight.text_97e68f7926"));
  }
  return { brief, records: (rows ?? []) as RecordData[] };
}
