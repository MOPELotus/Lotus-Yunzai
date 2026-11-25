import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { parseGachaDisplaySettings, type GachaDisplaySettings } from "@lotus-yunzai/gacha/display-settings";
import { gachaDisplayConfigBytes, gachaDisplayConfigName, readGachaDisplayConfig } from "./gacha-display-settings.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

const fields = [
  { key: "enabled", label: $t("lib.panel-gacha-settings.text_8425834877"), type: "boolean" },
  { key: "minSample", label: $t("lib.panel-gacha-settings.text_61c91ae060"), type: "number", min: 0, max: Number.MAX_SAFE_INTEGER,
    hint: $t("lib.panel-gacha-settings.text_a4c8a2ce0d") },
  { key: "detailRows", label: $t("lib.panel-gacha-settings.text_b489cab706"), type: "number", min: 0, max: Number.MAX_SAFE_INTEGER,
    hint: $t("lib.panel-gacha-settings.text_6d9a21b5c9") },
  { key: "versionRows", label: $t("lib.panel-gacha-settings.text_a91cd12d75"), type: "number", min: 0, max: Number.MAX_SAFE_INTEGER,
    hint: $t("lib.panel-gacha-settings.text_3416e91bb2") },
  { key: "levels", label: $t("lib.panel-gacha-settings.text_7510b1ff56"), type: "json",
    hint: $t("lib.panel-gacha-settings.text_4aa900b2a6") },
  { key: "models", label: $t("lib.panel-gacha-settings.text_8079a8b117"), type: "json",
    hint: $t("lib.panel-gacha-settings.text_d55effbe3e") },
] as const;

function flatten({ luck, detailRows, versionRows, models }: GachaDisplaySettings) {
  return { ...luck, detailRows, versionRows, models };
}

function input(value: unknown) {
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length ||
      !fields.every(({ key }) => Object.hasOwn(value, key))) return;
  return flatten(parseGachaDisplaySettings(value));
}

export function panelGachaSettings(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      if (request.method === "GET") {
        const values = flatten(parseGachaDisplaySettings(await readGachaDisplayConfig(root)));
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      }
      const body = await readPanelJson(request, gachaDisplayConfigBytes).catch(() => undefined);
      if (!body || typeof body !== "object" || !("previous" in body) || !("values" in body)) {
        return new Response(null, { status: 400 });
      }
      let previous: ReturnType<typeof input>, values: ReturnType<typeof input>;
      try {
        previous = input(body.previous);
        values = input(body.values);
      } catch (error) {
        return Response.json({ message: (error as Error).message }, { status: 400 });
      }
      if (!previous || !values) return new Response(null, { status: 400 });
      const snapshot = { fields, values };
      const saved = await updateLocalConfiguration(root, gachaDisplayConfigName, {
        signal: request.signal, canWrite: active, canCommit: active,
        prepare(text, local) {
          const current = flatten(parseGachaDisplaySettings(local));
          if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
          const changed = fields.filter(({ key }) => !isDeepStrictEqual(current[key], values[key]));
          if (!changed.length) return { value: snapshot };
          const document = parseDocument(text, { strict: true, uniqueKeys: true });
          if (document.errors.length) throw new GlobalConfigWriteError("config");
          for (const { key } of changed) document.set(key, values[key]);
          const yaml = document.toString({ lineWidth: 0 });
          if (Buffer.byteLength(yaml) > gachaDisplayConfigBytes ||
              !isDeepStrictEqual(flatten(parseGachaDisplaySettings(Bun.YAML.parse(yaml))), values)) {
            throw new GlobalConfigWriteError("config");
          }
          return { yaml, value: snapshot };
        },
      });
      return Response.json(saved);
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && error.reason === "permission") return new Response(null, { status: 401 });
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
