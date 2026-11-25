import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { WarpSettings } from "../plugins/starrail/simulation/settings.ts";
import { lockFile } from "./file-lock.ts";
import { readPanelJson } from "./panel.ts";

const allowanceKeys = ["special", "regular", "recallSeconds"] as const;
const rateKeys = ["characterFive", "characterFour", "coneFive", "coneFour", "featuredFive"] as const;
const poolKeys = ["characterFive", "characterFour", "coneFive", "coneFour"] as const;
const fields = [
  { key: "enabled", label: $t("lib.panel-starrail-warp-settings.text_bb3ab28000"), type: "boolean" },
  { key: "multiple", label: $t("lib.panel-starrail-warp-settings.text_83dc2a0959"), type: "boolean" },
  { key: "weeklyBonus", label: $t("lib.panel-starrail-warp-settings.text_c9d822251f"), type: "boolean",
    hint: $t("lib.panel-starrail-warp-settings.text_248f5f9571") },
  { key: "automaticPools", label: $t("lib.panel-starrail-warp-settings.text_d18fab6b6a"), type: "boolean",
    hint: $t("lib.panel-starrail-warp-settings.text_08fe9a48b5") },
  { key: "reincarnationMinutes", label: $t("lib.panel-starrail-warp-settings.text_b405fb5cc3"), type: "number", min: 1, max: 1440 },
  { key: "special", label: $t("lib.panel-starrail-warp-settings.text_e01bc9dbf8"), type: "number", min: 0, max: 10_000, hint: $t("lib.panel-starrail-warp-settings.text_8eabbe13fc") },
  { key: "regular", label: $t("lib.panel-starrail-warp-settings.text_b520619b36"), type: "number", min: 0, max: 10_000, hint: $t("lib.panel-starrail-warp-settings.text_8eabbe13fc") },
  { key: "recallSeconds", label: $t("lib.panel-starrail-warp-settings.text_36db990b5b"), type: "number", min: 0, max: 120, hint: $t("lib.panel-starrail-warp-settings.text_88a82045f8") },
  { key: "groups", label: $t("lib.panel-starrail-warp-settings.text_0d7583d991"), type: "json" },
  { key: "characterFive", label: $t("lib.panel-starrail-warp-settings.text_035406f55a"), type: "number", min: 0, max: 10_000 },
  { key: "characterFour", label: $t("lib.panel-starrail-warp-settings.text_bcff292549"), type: "number", min: 0, max: 10_000 },
  { key: "coneFive", label: $t("lib.panel-starrail-warp-settings.text_0b22ca9669"), type: "number", min: 0, max: 10_000 },
  { key: "coneFour", label: $t("lib.panel-starrail-warp-settings.text_8d5074055f"), type: "number", min: 0, max: 10_000 },
  { key: "featuredFive", label: $t("lib.panel-starrail-warp-settings.text_b7a73bc6f6"), type: "number", min: 0, max: 100, nullable: true,
    hint: $t("lib.panel-starrail-warp-settings.text_f934a1179a") },
  { key: "poolCharacterFive", label: $t("lib.panel-starrail-warp-settings.text_43dbf00106"), type: "list", separator: "line", hint: $t("lib.panel-starrail-warp-settings.text_3f9f77f05d") },
  { key: "poolCharacterFour", label: $t("lib.panel-starrail-warp-settings.text_7bc5ceb3a5"), type: "list", separator: "line", hint: $t("lib.panel-starrail-warp-settings.text_140a992481") },
  { key: "poolConeFive", label: $t("lib.panel-starrail-warp-settings.text_0feb25abd1"), type: "list", separator: "line", hint: $t("lib.panel-starrail-warp-settings.text_ccca00e786") },
  { key: "poolConeFour", label: $t("lib.panel-starrail-warp-settings.text_b73e12d051"), type: "list", separator: "line", hint: $t("lib.panel-starrail-warp-settings.text_ff9e4d8e0f") },
] as const;

type Config = Record<string, unknown>;
type SettingsStatus = 400 | 401 | 409;
class WarpPanelError extends Error {
  constructor(readonly status: SettingsStatus, message: string) { super(message); }
}

function record(value: unknown): Config | undefined {
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return value as Config;
}

function select(settings: Config, keys: readonly string[]) {
  return Object.fromEntries(keys.map(key => [key, settings[key]]));
}

function poolField(key: typeof poolKeys[number]) {
  return `pool${key[0]!.toUpperCase()}${key.slice(1)}`;
}

function fieldsFrom(settings: WarpSettings) {
  const { enabled, multiple, weeklyBonus, automaticPools, reincarnationMinutes, allowance, groups, rates, poolNames } = settings;
  return {
    enabled, multiple, weeklyBonus, automaticPools, reincarnationMinutes, ...allowance, groups, ...rates,
    ...Object.fromEntries(poolKeys.map(key => [poolField(key), poolNames[key] ?? []])),
  };
}

function settingsFrom(values: Config) {
  return {
    ...select(values, ["enabled", "multiple", "weeklyBonus", "automaticPools", "reincarnationMinutes", "groups"]),
    allowance: select(values, allowanceKeys),
    rates: select(values, rateKeys),
    poolNames: Object.fromEntries(poolKeys.flatMap(key => {
      const names = values[poolField(key)];
      return Array.isArray(names) && names.length === 0 ? [] : [[key, names]];
    })),
  };
}

export function panelStarRailWarpSettings(root: URL) {
  const directory = fileURLToPath(new URL("data/starrail/simulation/", root));
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    const verify = async () => {
      if (!active()) throw new WarpPanelError(401, $t("lib.panel-starrail-warp-settings.text_9af41270d6"));
    };
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      await verify();
      const { createWarpSettingsStore, defaultWarpSettings, parseWarpSettings } = await import("../plugins/starrail/simulation/settings.ts");
      const store = createWarpSettingsStore(lockFile, Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR?.trim() || directory);
      const snapshot = (settings: WarpSettings) => ({ fields, values: fieldsFrom(settings), defaults: fieldsFrom(defaultWarpSettings()) });
      if (request.method === "GET") {
        const settings = await store.read();
        await verify();
        return Response.json(snapshot(settings));
      }
      let body: Config | undefined;
      try { body = record(await readPanelJson(request, 1_048_576)); }
      catch { throw new WarpPanelError(400, $t("lib.panel-starrail-warp-settings.text_b075117bf7")); }
      const previous = record(body?.previous), values = record(body?.values);
      if (!body || Object.keys(body).length !== 2 || !previous || !values || Object.keys(values).length !== fields.length ||
          !fields.every(({ key }) => Object.hasOwn(values, key))) throw new WarpPanelError(400, $t("lib.panel-starrail-warp-settings.text_b075117bf7"));
      let next: WarpSettings;
      try { next = parseWarpSettings(settingsFrom(values)); }
      catch { throw new WarpPanelError(400, $t("lib.panel-starrail-warp-settings.text_cbb7b0c33e")); }
      const saved = await store.update(current => {
        if (!isDeepStrictEqual(fieldsFrom(current), previous)) throw new WarpPanelError(409, $t("lib.panel-starrail-warp-settings.text_9b81579673"));
        return next;
      }, verify);
      return Response.json(snapshot(saved));
    } catch (error) {
      if (!active()) return new Response(null, { status: 401 });
      if (error instanceof WarpPanelError) return Response.json({ message: error.message }, { status: error.status });
      return new Response(null, { status: 500 });
    }
  };
}
