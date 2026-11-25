import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import type { CalendarSchedule } from "../plugins/guides/calendar-schedule.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

type Values = Readonly<Record<string, unknown>>;
type Session = { readonly signal: AbortSignal; readonly canWrite: () => boolean };
type Field = {
  readonly key: string;
  readonly label: string;
  readonly type: "boolean" | "number" | "select" | "list" | "json";
  readonly options?: readonly { readonly label: string; readonly value: number | string }[];
  readonly min?: number;
  readonly max?: number;
  readonly hint?: string;
  readonly itemType?: "number";
};

class GuidesPanelError extends Error {
  constructor(readonly status: 400 | 404) { super(String(status)); }
}

function record(value: unknown): Values | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Values;
}

function endpoint<T extends Values>(load: () => Promise<{
  fields: readonly Field[];
  read(): Promise<T>;
  write(previous: Values, values: Values, session: Session): Promise<T>;
}>) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    let requested: { previous: Values; values: Values } | undefined;
    if (request.method === "PUT") {
      let body: Values | undefined;
      try { body = record(await readPanelJson(request)); } catch {}
      const previous = record(body?.previous), values = record(body?.values);
      if (!body || Object.keys(body).length !== 2 || !previous || !values) return new Response(null, { status: 400 });
      requested = { previous, values };
    }
    try {
      const { fields, read, write } = await load();
      const values = requested ? await write(requested.previous, requested.values, { signal: request.signal, canWrite: active }) : await read();
      return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
    } catch (cause) {
      const code = cause instanceof GlobalConfigWriteError ? cause.reason :
        cause instanceof Error && "code" in cause ? cause.code : undefined;
      const status = !active() || code === "permission" || code === "cancelled" ? 401
        : cause instanceof GuidesPanelError ? cause.status : code === "input" ? 400 : code === "conflict" ? 409 : 500;
      return new Response(null, { status });
    }
  };
}

function includesExactly(values: Values, fields: readonly Field[]) {
  return Object.keys(values).length === fields.length && fields.every(field => Object.hasOwn(values, field.key));
}

const collectionHint = $t("lib.panel-guides-settings.text_ab58d9861f");
const guideFields = [
  { key: "forward", label: $t("lib.panel-guides-settings.text_d9f92b561c"), type: "boolean", hint: $t("lib.panel-guides-settings.text_8a7df858b1") },
  { key: "auto_update", label: $t("lib.panel-guides-settings.text_c343df569b"), type: "boolean", hint: $t("lib.panel-guides-settings.text_052ec84604") },
  { key: "gs_collections", label: $t("lib.panel-guides-settings.text_fb6ae95d5a"), type: "json", hint: $t("lib.panel-guides-settings.text_9a1e983d54") + collectionHint },
  { key: "sr_collections", label: $t("lib.panel-guides-settings.text_4eea8d106e"), type: "json", hint: $t("lib.panel-guides-settings.text_9b744540a2") + collectionHint },
  { key: "zzz_collections", label: $t("lib.panel-guides-settings.text_0b30450a32"), type: "json", hint: $t("lib.panel-guides-settings.text_9b744540a2") + collectionHint },
] as const satisfies readonly Field[];

export function panelGuidesSettings(root: URL) {
  return endpoint(async () => {
    const [{ guideFlags, readGuidesConfiguration }, { parseGuideCollections, readGuideAuthors }] = await Promise.all([
      import("../plugins/guides/guide-configuration.ts"), import("../plugins/guides/role-guide-collections.ts"),
    ]);
    const collections = Bun.env.LOTUS_GUIDES_ROLE_CONFIG_DIR?.trim() || fileURLToPath(new URL("config/guides/", root));
    async function read() {
      const [config, gs, sr, zzz] = await Promise.all([
        readGuidesConfiguration(root), readGuideAuthors("gs", collections, root),
        readGuideAuthors("sr", collections, root), readGuideAuthors("zzz", collections, root),
      ]);
      return { ...guideFlags(config), gs_collections: gs, sr_collections: sr.news, zzz_collections: zzz.news };
    }
    function decode(values: Values) {
      if (!includesExactly(values, guideFields) || typeof values.forward !== "boolean" || typeof values.auto_update !== "boolean" ||
          !record(values.gs_collections) || !Array.isArray(record(values.gs_collections)?.news) || !Array.isArray(record(values.gs_collections)?.olds)) {
        throw new GuidesPanelError(400);
      }
      try {
        return {
          forward: values.forward, auto_update: values.auto_update, gs_collections: parseGuideCollections("gs", values.gs_collections),
          sr_collections: parseGuideCollections("sr", values.sr_collections).news,
          zzz_collections: parseGuideCollections("zzz", values.zzz_collections).news,
        };
      } catch { throw new GuidesPanelError(400); }
    }
    return {
      fields: guideFields, read,
      write(previous, values, { signal, canWrite }) {
        const expected = decode(previous), next = decode(values);
        return updateLocalConfiguration(root, "guides", {
          signal, canWrite, canCommit: canWrite, resolveEffective: read,
          prepare(text, local, effective) {
            if (!isDeepStrictEqual(effective, expected)) throw new GlobalConfigWriteError("conflict");
            if (isDeepStrictEqual(expected, next)) return { value: next };
            const document = parseDocument(text, { strict: true, uniqueKeys: true });
            if (document.errors.length || document.contents && !isMap(document.contents)) throw new GlobalConfigWriteError("config");
            const updated = { ...local };
            for (const { key } of guideFields) {
              if (isDeepStrictEqual(expected[key], next[key])) continue;
              document.set(key, next[key]);
              updated[key] = next[key];
            }
            const yaml = document.toString({ lineWidth: 0 });
            if (Buffer.byteLength(yaml) > 64 * 1024 || !isDeepStrictEqual(Bun.YAML.parse(yaml), updated)) {
              throw new GlobalConfigWriteError("config");
            }
            return { yaml, value: next };
          },
        });
      },
    };
  });
}

function roleCache(root: URL) {
  return Bun.env.LOTUS_GUIDES_ROLE_DIR?.trim() || fileURLToPath(new URL("data/guides/roleGuides/", root));
}

export function panelGenshinGuideSettings(root: URL) {
  return endpoint(async () => {
    const { createGenshinStrategyPreference, genshinStrategySource } = await import("../plugins/guides/genshin-strategy.ts");
    const fields = [{ key: "defaultSource", type: "select", label: $t("lib.panel-guides-settings.text_4a9e2be80b"),
      hint: $t("lib.panel-guides-settings.text_794dfbfbf7"),
      options: Array.from({ length: 7 }, (_, index) => ({ label: `${index + 1} · ${genshinStrategySource(index + 1)!.source}`, value: index + 1 })),
    }] as const satisfies readonly Field[];
    const strategy = createGenshinStrategyPreference(join(roleCache(root), "genshin-strategy.json"),
      fileURLToPath(new URL("plugins/genshin/config/mys.set.yaml", root)));
    return {
      fields,
      read: async () => ({ defaultSource: await strategy.get() }),
      async write(previous, values, { canWrite }) {
        if (!includesExactly(previous, fields) || !includesExactly(values, fields) ||
            typeof previous.defaultSource !== "number" || typeof values.defaultSource !== "number") throw new GuidesPanelError(400);
        return { defaultSource: await strategy.set(values.defaultSource, { previous: previous.defaultSource, canWrite }) };
      },
    };
  });
}

export function panelStarRailGuideSettings(root: URL) {
  return endpoint(async () => {
    const { createStarRailStrategyPreference, starRailStrategyOptions, validStarRailStrategyChoice } =
      await import("../plugins/guides/starrail-strategy.ts");
    const fields = [{
      key: "defaultSource", type: "select", label: $t("lib.panel-guides-settings.text_d1da93c801"),
      hint: $t("lib.panel-guides-settings.text_478d4fb7d4"),
      options: starRailStrategyOptions,
    }] as const satisfies readonly Field[];
    const strategy = createStarRailStrategyPreference({ cache: roleCache(root), settingsRoot: root });
    function decode(values: Values) {
      if (!includesExactly(values, fields) || !validStarRailStrategyChoice(values.defaultSource)) throw new GuidesPanelError(400);
      return values.defaultSource;
    }
    return {
      fields,
      read: async () => ({ defaultSource: await strategy.get() }),
      async write(previous, values, { canWrite }) {
        return { defaultSource: await strategy.set(decode(values), { previous: decode(previous), canWrite }) };
      },
    };
  });
}

export function panelZzzGuideSettings(root: URL) {
  return endpoint(async () => {
    const { createZzzStrategySettings, zzzStrategyOptions } = await import("../plugins/guides/zzz-strategy.ts");
    const fields = [
      { key: "default_guide", type: "select", label: $t("lib.panel-guides-settings.text_4a9e2be80b"), options: zzzStrategyOptions },
      { key: "max_forward_guides", type: "number", label: $t("lib.panel-guides-settings.text_22ce32c346"), min: 1, max: 7 },
    ] as const satisfies readonly Field[];
    const legacy = Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR?.trim() || fileURLToPath(new URL("plugins/ZZZ-Plugin/resources/", root));
    const strategy = createZzzStrategySettings({ cache: roleCache(root), legacyRoot: dirname(legacy) });
    function decode(values: Values) {
      const { default_guide, max_forward_guides } = values;
      if (!includesExactly(values, fields) || typeof default_guide !== "number" || typeof max_forward_guides !== "number") {
        throw new GuidesPanelError(400);
      }
      return { default_guide, max_forward_guides };
    }
    return {
      fields, read: strategy.read,
      write: (previous, values, { canWrite }) => strategy.write(decode(values), { previous: decode(previous), canWrite }),
    };
  });
}

export function panelGuideCalendarSettings(getSchedule: () => CalendarSchedule | undefined) {
  const fields = [
    { key: "whiteList", label: $t("lib.panel-guides-settings.text_534e588bf6"), type: "list", itemType: "number" },
    { key: "blackList", label: $t("lib.panel-guides-settings.text_ed2691435e"), type: "list", itemType: "number", hint: $t("lib.panel-guides-settings.text_0b1f65f1dd") },
    { key: "tasks", label: $t("lib.panel-guides-settings.text_db97221170"), type: "json",
      hint: $t("lib.panel-guides-settings.text_7ad38b42ad") },
  ] as const satisfies readonly Field[];
  return endpoint(async () => {
    const schedule = getSchedule();
    if (!schedule) throw new GuidesPanelError(404);
    return {
      fields, read: async () => ({ ...await schedule.readSettings() }),
      async write(previous, values, { signal, canWrite }) {
        return { ...await schedule.writeSettings(previous, values, { signal, canWrite: () => canWrite() && getSchedule() === schedule }) };
      },
    };
  });
}
