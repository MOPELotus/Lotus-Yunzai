import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isDeepStrictEqual } from "node:util";
import { parseWishSettings } from "./genshin-wish-settings-model.ts";
import { GlobalConfigWriteError } from "./lotus-global-config-write.ts";
import { readGenshinWishSettings, updateGenshinWishSettings, wishConfigMaxBytes } from "./genshin-wish-settings.ts";
import { readPanelJson } from "./panel.ts";

const fields = [
  { key: "enabled", label: $t("lib.panel-genshin-wish-settings.text_8cba26b1e4"), type: "boolean" },
  { key: "multiple", label: $t("lib.panel-genshin-wish-settings.text_83dc2a0959"), type: "boolean" },
  { key: "characterFive", label: $t("lib.panel-genshin-wish-settings.text_035406f55a"), type: "number", min: 0, max: 10_000 },
  { key: "characterFour", label: $t("lib.panel-genshin-wish-settings.text_bcff292549"), type: "number", min: 0, max: 10_000 },
  { key: "weaponFive", label: $t("lib.panel-genshin-wish-settings.text_265412beac"), type: "number", min: 0, max: 10_000 },
  { key: "weaponFour", label: $t("lib.panel-genshin-wish-settings.text_fdd667ff85"), type: "number", min: 0, max: 10_000 },
  { key: "featuredFive", label: $t("lib.panel-genshin-wish-settings.text_b7a73bc6f6"), type: "number", min: 0, max: 100, nullable: true,
    hint: $t("lib.panel-genshin-wish-settings.text_d5782dc3f7") },
  { key: "automaticPools", label: $t("lib.panel-genshin-wish-settings.text_d18fab6b6a"), type: "boolean",
    hint: $t("lib.panel-genshin-wish-settings.text_f744fade1e") },
  { key: "poolCharacterFive", label: $t("lib.panel-genshin-wish-settings.text_43dbf00106"), type: "list", separator: "line",
    hint: $t("lib.panel-genshin-wish-settings.text_1b37699930") },
  { key: "poolCharacterFour", label: $t("lib.panel-genshin-wish-settings.text_7bc5ceb3a5"), type: "list", separator: "line",
    hint: $t("lib.panel-genshin-wish-settings.text_580e192cf9") },
  { key: "poolWeaponFive", label: $t("lib.panel-genshin-wish-settings.text_c6b2b2b2c7"), type: "list", separator: "line",
    hint: $t("lib.panel-genshin-wish-settings.text_24b1027501") },
  { key: "poolWeaponFour", label: $t("lib.panel-genshin-wish-settings.text_b236752677"), type: "list", separator: "line",
    hint: $t("lib.panel-genshin-wish-settings.text_fe7ceea780") },
  { key: "pink", label: $t("lib.panel-genshin-wish-settings.text_2e81a33b5c"), type: "number", min: 0, max: 10_000,
    hint: $t("lib.panel-genshin-wish-settings.text_caed033fb3") },
  { key: "blue", label: $t("lib.panel-genshin-wish-settings.text_dd9da8d39a"), type: "number", min: 0, max: 10_000 },
  { key: "recallSeconds", label: $t("lib.panel-genshin-wish-settings.text_b2f7bf43e9"), type: "number", min: 0, max: 120, hint: $t("lib.panel-genshin-wish-settings.text_88a82045f8") },
  { key: "privateSingleRecallSeconds", label: $t("lib.panel-genshin-wish-settings.text_d709362af8"), type: "number", min: 0, max: 120,
    hint: $t("lib.panel-genshin-wish-settings.text_eeae71a5d4") },
  { key: "reincarnationMinutes", label: $t("lib.panel-genshin-wish-settings.text_b405fb5cc3"), type: "number", min: 1, max: 1440,
    hint: $t("lib.panel-genshin-wish-settings.text_1563cc197c") },
  { key: "dailyDrawLimits", label: $t("lib.panel-genshin-wish-settings.text_9fe647a91c"), type: "json", rows: 8,
    hint: $t("lib.panel-genshin-wish-settings.text_b6020c0b6b") },
  { key: "groups", label: $t("lib.panel-genshin-wish-settings.text_0d7583d991"), type: "json",
    hint: $t("lib.panel-genshin-wish-settings.text_faf7f02784") },
] as const;

function input(value: unknown) {
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length ||
      !fields.every(({ key }) => Object.hasOwn(value, key))) return;
  return parseWishSettings(value);
}

export function panelGenshinWishSettings(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      if (request.method === "GET") {
        const values = await readGenshinWishSettings(root);
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      }
      const body = await readPanelJson(request, wishConfigMaxBytes).catch(() => undefined);
      if (!body || typeof body !== "object" || !("previous" in body) || !("values" in body)) {
        return new Response(null, { status: 400 });
      }
      let previous: ReturnType<typeof input>, next: ReturnType<typeof input>;
      try {
        previous = input(body.previous);
        next = input(body.values);
      } catch (error) {
        return Response.json({ message: (error as Error).message }, { status: 400 });
      }
      if (!previous || !next) return new Response(null, { status: 400 });
      let normalized;
      try {
        const { normalizeWishManualPoolChanges } = await import("../plugins/genshin/wish-sim/admin-pools.ts");
        normalized = await normalizeWishManualPoolChanges(previous, next);
      } catch (error) {
        if (error instanceof TypeError) return Response.json({ message: error.message }, { status: 400 });
        throw error;
      }
      const values = await updateGenshinWishSettings(root, current => {
        if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
        return normalized;
      }, active, request.signal);
      return Response.json({ fields, values });
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && error.reason === "permission") return new Response(null, { status: 401 });
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
