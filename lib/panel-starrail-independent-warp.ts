import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { lockFile } from "./file-lock.ts";
import { readPanelJson } from "./panel.ts";

const fields = [
  { key: "enabled", label: $t("lib.panel-starrail-independent-warp.text_af0f77424b"), type: "boolean",
    hint: $t("lib.panel-starrail-independent-warp.text_afaf37aea6") },
  { key: "group", label: $t("lib.panel-starrail-independent-warp.text_946c96eb71"), type: "boolean" },
  { key: "private", label: $t("lib.panel-starrail-independent-warp.text_4e7fb2a2eb"), type: "boolean" },
  { key: "dailyTenPulls", label: $t("lib.panel-starrail-independent-warp.text_7df60e2220"), type: "number", min: 0,
    hint: $t("lib.panel-starrail-independent-warp.text_05092333e0") },
  { key: "disabledGroups", label: $t("lib.panel-starrail-independent-warp.text_126d480b3b"), type: "list", separator: "line" },
  { key: "recallSeconds", label: $t("lib.panel-starrail-independent-warp.text_7009d6f335"), type: "number", min: 0, max: 2_147_483,
    hint: $t("lib.panel-starrail-independent-warp.text_88a82045f8") },
] as const;

class SettingsConflict extends Error {}

export function panelStarRailIndependentWarp(root: URL) {
  const directory = fileURLToPath(new URL("data/starrail/simulation/", root));
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    const verify = async () => { if (!active()) throw new Error($t("lib.panel-starrail-independent-warp.text_9af41270d6")); };
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    try {
      const { createIndependentWarpSettingsStore, parseIndependentWarpSettings } =
        await import("../plugins/starrail/simulation/independent-settings.ts");
      const store = createIndependentWarpSettingsStore(lockFile, Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR?.trim() || directory);
      if (request.method === "GET") {
        const values = await store.read();
        await verify();
        return Response.json({ fields, values });
      }
      let next, previous;
      try {
        const body = await readPanelJson(request, 128 * 1024) as { values?: unknown; previous?: unknown };
        next = parseIndependentWarpSettings(body.values);
        previous = parseIndependentWarpSettings(body.previous);
      } catch {
        return Response.json({ message: $t("lib.panel-starrail-independent-warp.text_19c5551b74") }, { status: 400 });
      }
      const saved = await store.update(current => {
        if (!isDeepStrictEqual(current, previous)) throw new SettingsConflict($t("lib.panel-starrail-independent-warp.text_23e2075707"));
        return next;
      }, verify);
      return Response.json({ fields, values: saved });
    } catch (error) {
      if (!active()) return new Response(null, { status: 401 });
      if (error instanceof SettingsConflict) return Response.json({ message: error.message }, { status: 409 });
      return new Response(null, { status: 500 });
    }
  };
}
