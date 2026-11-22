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
  readonly options?: readonly { readonly label: string; readonly value: number }[];
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

const collectionHint = '作者条目格式为 {"source":"作者名","collection_id":[合集编号]}。';
const guideFields = [
  { key: "forward", label: "攻略合集和配队多图合并转发", type: "boolean", hint: "保存后重启生效，也用于参考面板、复刻表和深渊资料。" },
  { key: "auto_update", label: "定时同步攻略、配队和参考资料", type: "boolean", hint: "保存后重启生效，手动更新仍可用。" },
  { key: "gs_collections", label: "原神攻略合集", type: "json", hint: '按 {"news":[],"olds":[]} 分组。' + collectionHint },
  { key: "sr_collections", label: "星铁攻略合集", type: "json", hint: "填写作者条目数组。" + collectionHint },
  { key: "zzz_collections", label: "绝区零攻略合集", type: "json", hint: "填写作者条目数组。" + collectionHint },
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
    const fields = [{ key: "defaultSource", type: "select", label: "默认编号来源",
      hint: "普通角色攻略没有图时使用。",
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

export function panelZzzGuideSettings(root: URL) {
  return endpoint(async () => {
    const { createZzzStrategySettings, zzzStrategyOptions } = await import("../plugins/guides/zzz-strategy.ts");
    const fields = [
      { key: "default_guide", type: "select", label: "默认编号来源", options: zzzStrategyOptions },
      { key: "max_forward_guides", type: "number", label: "全部攻略最多转发条数", min: 1, max: 7 },
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
    { key: "whiteList", label: "推送群白名单", type: "list", itemType: "number" },
    { key: "blackList", label: "推送群黑名单", type: "list", itemType: "number", hint: "同一群同时出现时按黑名单处理。" },
    { key: "tasks", label: "日历推送任务", type: "json",
      hint: '填写任务数组，例如 [{"cron":"0 9 * * *","type":"G"}]。S 为星铁，G 为原神，* 为两者。保存后生效。' },
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
