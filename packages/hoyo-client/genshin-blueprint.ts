import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { normalizeProfileRoleArtworkUrl, type ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { genshinCnRecordRegion } from "./game-record.ts";
import { requestGenshinCalculator } from "./genshin-backpack.ts";

const kind = "尘歌壶模数";
type Json = Record<string, unknown>;

export interface GenshinBlueprintOptions {
  readonly code: string;
  readonly signal?: AbortSignal;
}

export interface GenshinBlueprintItem {
  readonly name: string;
  readonly count: number;
  readonly icon?: string;
}

export interface GenshinBlueprint {
  readonly code: string;
  readonly uid: string;
  readonly furniture: readonly GenshinBlueprintItem[];
  readonly materials: readonly GenshinBlueprintItem[];
}

function invalid(): never {
  throw new HoyoRequestError("response", $t("genshin-blueprint.text_c7bcc8d301"));
}

function rows(data: Json) {
  if (!Array.isArray(data.list) || data.list.length > 512) invalid();
  return Array.from(data.list, (row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) invalid();
    return row as Json;
  });
}

function number(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) invalid();
  return parsed;
}

function item(row: Json, field: "icon_url" | "icon"): GenshinBlueprintItem {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name || !name.isWellFormed() || Buffer.byteLength(name) > 256 || /[\p{Cc}\p{Cf}]/u.test(name)) invalid();
  const icon = normalizeProfileRoleArtworkUrl(row[field]);
  return { name, count: number(row.num, field === "icon_url" ? 1 : 0, 1_000_000), ...(icon && { icon }) };
}

export function createGenshinBlueprintReader() {
  // One reader per query reuses the verified share after a same-profile refresh on the computation stage.
  let verified: { readonly code: string; readonly uid: string; readonly region: string;
    readonly furniture: readonly GenshinBlueprintItem[]; readonly body: string } | undefined;
  return async (source: ProfileRequestContext, transport: HoyoTransport, { code, signal }: GenshinBlueprintOptions,
    verifyProfile?: () => Promise<void>): Promise<GenshinBlueprint> => {
    const { uid } = source.role;
    const region = genshinCnRecordRegion(source.role);
    if (source.game !== "gs" || !region) {
      throw new HoyoRequestError("invalid-input", $t("genshin-blueprint.text_8552020fa7"));
    }
    if (!/^\d{10,15}$/u.test(code)) throw new HoyoRequestError("invalid-input", $t("genshin-blueprint.text_1b5e488ddf"));
    if (!verified || verified.code !== code || verified.uid !== uid || verified.region !== region) {
      const query = new URLSearchParams({ share_code: code, region });
      const blueprint = await requestGenshinCalculator(source, transport, kind, "v1/furniture/blueprint", { query, signal, verifyProfile });
      if (Object.hasOwn(blueprint, "share_code") && String(blueprint.share_code) !== code) invalid();
      const list = rows(blueprint);
      const furniture = list.map(row => item(row, "icon_url"));
      const body = JSON.stringify({ list: list.map((row, index) => ({ cnt: furniture[index]!.count, id: number(row.id, 1) })) });
      verified = { code, uid, region, furniture, body };
    }
    const { furniture, body } = verified;
    if (!furniture.length) return { uid, code, furniture, materials: [] };
    const result = await requestGenshinCalculator(source, transport, kind, "v1/furniture/compute", { body, signal, verifyProfile });
    return { uid, code, furniture, materials: rows(result).map(row => item(row, "icon")) };
  };
}
