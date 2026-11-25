import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export type StarRailRogueOptions = { readonly signal?: AbortSignal } &
  ({ readonly kind: "starrail-rogue"; readonly scheduleType: 1 | 2 } |
  { readonly kind: "starrail-rogue-locust" | "starrail-rogue-tourn" });

export type StarRailRoguePayload = Record<string, unknown>;

function object(value: unknown): StarRailRoguePayload | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as StarRailRoguePayload;
}

// Fixed route and field contracts from TsukinaKasumi/StarRail-plugin 308a83d.
export async function readStarRailRogue(source: ProfileRequestContext, transport: HoyoTransport,
  options: StarRailRogueOptions, verifyProfile?: () => Promise<void>): Promise<{ data: StarRailRoguePayload }> {
  if (!["starrail-rogue", "starrail-rogue-locust", "starrail-rogue-tourn"].includes(options.kind)) {
    throw new HoyoRequestError("invalid-input", $t("starrail-rogue.text_3192ab412a"));
  }
  const { data, region } = await readCnGameRecord(source, transport, options, verifyProfile);
  const role = object(data.role);
  const invalidShape = () => new HoyoRequestError("response", $t("starrail-rogue.text_435ac71733"));
  if (data.role != null && !role) throw invalidShape();
  for (const identity of role ? [data, role] : [data]) {
    if (["uid", "role_id", "game_uid"].some(key => Object.hasOwn(identity, key) && String(identity[key]) !== source.role.uid) ||
        ["region", "server"].some(key => Object.hasOwn(identity, key) && identity[key] !== region) ||
        (Object.hasOwn(identity, "game_biz") && identity.game_biz !== source.role.gameBiz)) {
      throw new HoyoRequestError("response", $t("starrail-rogue.text_433ceb1e94"));
    }
  }
  const sections = options.kind === "starrail-rogue" ? ["current_record", "last_record"] :
    options.kind === "starrail-rogue-locust" ? ["detail"] : ["normal_detail", "cur_week_detail", "last_week_detail"];
  for (const name of sections) {
    if (data[name] == null) continue;
    const section = object(data[name]);
    if (!section || (section.records != null && (!Array.isArray(section.records) ||
        section.records.length > 64 || section.records.some(entry => !object(entry))))) throw invalidShape();
  }
  return { data };
}
