import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

type Configuration = Record<string, unknown>;
type SettingValue = boolean | string | number | Record<string, number[]>;
type Values = Record<string, SettingValue>;
type Field = {
  key: string;
  label: string;
  type: "boolean" | "number" | "text" | "json" | "select";
  options?: readonly { label: string; value: string }[];
  min?: number;
  hint?: string;
};

export const panelMysNoticeGames = { gs: "原神", sr: "星铁", zzz: "绝区零", bbb: "崩坏3", bb: "崩坏学园2", wd: "未定事件簿" } as const;
export const panelMysActivityGames = ["gs", "sr"] as const;
type Game = keyof typeof panelMysNoticeGames;
const gameKeys = Object.keys(panelMysNoticeGames) as Game[];
const targetHint = "以机器人 QQ 为键，值为群号数组。群内订阅命令产生的覆盖优先；下一轮生效。";
const logLevels = ["debug", "info", "warn", "error"];
const localFields: readonly Field[] = [
  { key: "enableSchedule", label: "自动投递当前公告", type: "boolean", hint: "保存后重启宿主生效。" },
  { key: "scheduleTime", label: "自动投递窗口（北京时间）", type: "text", hint: "格式如 08:00-08:30，每天在窗口内选一次。保存后重启宿主生效。" },
  { key: "logger", label: "独立公告日志级别", type: "select", options: logLevels.map(value => ({ label: value, value })),
    hint: "保存后重启宿主生效。" },
];
const mysFields: readonly Field[] = [
  { key: "pushTime", label: "查询与推送 Cron", type: "text", hint: "修改 Cron 后重启宿主生效。" },
  { key: "maxNum", label: "每轮推送上限", type: "number", min: 0, hint: "每个游戏的公告与资讯共用上限。0 表示不发送；下一轮生效。" },
  ...gameKeys.flatMap((game): Field[] => [
    { key: `${game}announceGroup`, label: panelMysNoticeGames[game] + "公告目标", type: "json", hint: targetHint },
    { key: `${game}infoGroup`, label: panelMysNoticeGames[game] + "资讯目标", type: "json", hint: targetHint },
    { key: `${game}BanWord`, label: panelMysNoticeGames[game] + "标题过滤", type: "text", hint: "正则表达式。留空则不过滤；下一轮生效。" },
  ]),
  ...panelMysActivityGames.map((game): Field => ({
    key: `${game}ActivityPush`, label: panelMysNoticeGames[game] + "活动到期目标", type: "json", hint: targetHint,
  })),
];

class InvalidNoticeSettings extends Error {}

function record(value: unknown): Configuration | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Configuration : undefined;
}

async function readYaml(path: URL | string) {
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const parsed: unknown = Bun.YAML.parse(content);
  if (parsed == null) return {};
  const document = record(parsed);
  if (!document) throw new GlobalConfigWriteError("config");
  return document;
}

async function readSchedule(root: URL, override?: string) {
  if (override) return await readYaml(override) ?? { enableSchedule: false };
  const current = await readYaml(new URL("config/notice.yaml", root));
  if (current) return current;
  const { parseNoticeSchedule } = await import("../plugins/notice/schedule.ts");
  let legacy: { document: Configuration; window: ReturnType<typeof parseNoticeSchedule> } | undefined;
  for (const name of ["Notice-plugin", "notice-plugin"]) {
    const directory = new URL(`plugins/${name}/config/`, root);
    const settings = await readYaml(new URL("config.yaml", directory));
    const defaults = await readYaml(new URL("config_default.yaml", directory));
    if (!settings && !defaults) continue;
    const document = { ...defaults, ...settings };
    const window = parseNoticeSchedule(JSON.stringify(document));
    if (legacy && (!isDeepStrictEqual(legacy.window, window) || logLevel(legacy.document) !== logLevel(document))) {
      throw new GlobalConfigWriteError("config");
    }
    legacy = { document, window };
  }
  return legacy?.document ?? { enableSchedule: false };
}

function logLevel(config: Configuration) {
  return typeof config.logger === "string" && logLevels.includes(config.logger) ? config.logger : "info";
}

async function readMysConfig(root: URL): Promise<Configuration> {
  const { announcementConfigPaths } = await import("../plugins/notice/mys-announcement-config.ts");
  for (const path of announcementConfigPaths) {
    const document = await readYaml(new URL(path, root));
    if (document) return document;
  }
  return {};
}

function targetMapping(value: unknown) {
  const source = record(value);
  if (!source || Object.keys(source).length > 500) throw new InvalidNoticeSettings();
  const validId = (value: unknown) => {
    const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new InvalidNoticeSettings();
    return id;
  };
  const targets: Record<string, number[]> = {};
  for (const [id, groups] of Object.entries(source)) {
    if (!Array.isArray(groups) || groups.length > 5000) throw new InvalidNoticeSettings();
    targets[validId(id)] = [...new Set(groups.map(validId))];
  }
  return targets;
}

function changes(fields: readonly Field[], value: Configuration): Values {
  const validated: Values = {};
  for (const [key, supplied] of Object.entries(value)) {
    const field = fields.find((item) => item.key === key);
    if (!field) throw new InvalidNoticeSettings();
    if (field.type === "json") validated[key] = targetMapping(supplied);
    else if (field.type === "boolean" && typeof supplied === "boolean") validated[key] = supplied;
    else if (field.type === "select" && typeof supplied === "string" && field.options?.some(({ value }) => value === supplied)) {
      validated[key] = supplied;
    }
    else if (field.type === "number" && typeof supplied === "number" && Number.isSafeInteger(supplied) && supplied >= (field.min ?? 0)) {
      validated[key] = supplied;
    } else if (field.type === "text" && typeof supplied === "string" && supplied.length <= (key.endsWith("BanWord") ? 4096 : 160)) {
      validated[key] = supplied;
    } else throw new InvalidNoticeSettings();
  }
  return validated;
}

interface NoticeSettings {
  name: "notice" | "mys.pushNews";
  fields: readonly Field[];
  override?: string;
  restartKeys: readonly string[];
  read(): Promise<Configuration>;
  snapshot(effective: Configuration): Promise<Values> | Values;
  patch(changed: Values, effective: Configuration): Configuration;
  validate(effective: Configuration): Promise<void>;
}

function endpoint(root: URL, settings: NoticeSettings) {
  const { fields, name, override, restartKeys, read, snapshot, patch, validate } = settings;
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method === "GET") {
      try {
        const values = await snapshot(await read());
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      } catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });

    let previous: Configuration, proposed: Values;
    try {
      const body = record(await readPanelJson(request));
      const before = record(body?.previous);
      const values = record(body?.values);
      if (!body || Object.keys(body).length !== 2 || !before || !values || Object.keys(before).length !== fields.length ||
          fields.some(({ key }) => !Object.hasOwn(before, key))) {
        throw new InvalidNoticeSettings();
      }
      previous = before;
      proposed = changes(fields, values);
    } catch { return new Response(null, { status: 400 }); }
    try {
      // The effective document can be inherited from a legacy path on first edit.
      const effective = await read();
      if (!isDeepStrictEqual(await snapshot(effective), previous)) throw new GlobalConfigWriteError("conflict");
      const changed = Object.fromEntries(Object.entries(proposed).filter(([key, value]) => !isDeepStrictEqual(value, previous[key])));
      const updates = patch(changed, effective);
      const next = { ...effective, ...updates };
      await validate(next).catch(() => { throw new InvalidNoticeSettings(); });
      const values = await snapshot(next);
      const value = { fields, values, ...(restartKeys.some(key => Object.hasOwn(changed, key)) && {
        warning: "设置已保存。重启宿主后生效。",
      }) };
      return Response.json(await updateLocalConfiguration(root, name, {
        override, canWrite: active, canCommit: active, signal: request.signal, resolveEffective: read,
        prepare(source, local, current) {
          if (!isDeepStrictEqual(current, effective)) throw new GlobalConfigWriteError("conflict");
          if (!Object.keys(updates).length) return { value };
          const doc = parseDocument(source, { merge: true, uniqueKeys: true });
          if (doc.errors.length || (doc.contents && !isMap(doc.contents))) throw new GlobalConfigWriteError("config");
          for (const [key, value] of Object.entries(next)) {
            if (!Object.hasOwn(updates, key) && Object.hasOwn(local, key)) continue;
            const words = key === "banWord" ? record(value) : undefined;
            if (words && isMap(doc.get("banWord", true))) {
              const prior = record(local.banWord);
              for (const [game, pattern] of Object.entries(words)) {
                if (!isDeepStrictEqual(prior?.[game], pattern)) doc.setIn(["banWord", game], pattern);
              }
            } else doc.set(key, value);
          }
          const yaml = doc.toString({ lineWidth: 0 });
          if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...local, ...next })) throw new GlobalConfigWriteError("config");
          return { yaml, value };
        },
      }));
    } catch (error) {
      if (error instanceof InvalidNoticeSettings) return new Response(null, { status: 400 });
      if (error instanceof GlobalConfigWriteError) {
        const status = error.reason === "conflict" ? 409 : error.reason === "permission" || error.reason === "cancelled" ? 401 : 500;
        return new Response(null, { status });
      }
      return new Response(null, { status: 500 });
    }
  };
}

export function panelNoticeSettings(root: URL) {
  const override = Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG || undefined;
  return endpoint(root, {
    name: "notice", fields: localFields, override, restartKeys: ["enableSchedule", "scheduleTime", "logger"],
    read: () => readSchedule(root, override),
    snapshot(config) {
      return {
        enableSchedule: config.enableSchedule !== false,
        scheduleTime: typeof config.scheduleTime === "string" ? config.scheduleTime : "8:00-8:30",
        logger: logLevel(config),
      };
    },
    patch: (changed, effective) => Object.hasOwn(changed, "scheduleTime") && !Object.hasOwn(changed, "enableSchedule")
      ? { ...changed, enableSchedule: effective.enableSchedule !== false }
      : changed,
    async validate(config) {
      const { parseNoticeSchedule } = await import("../plugins/notice/schedule.ts");
      parseNoticeSchedule(JSON.stringify({ ...config, enableSchedule: true }));
    },
  });
}

export function panelNoticeMysSettings(root: URL, validateCron: (cron: string) => boolean) {
  return endpoint(root, {
    name: "mys.pushNews", fields: mysFields, restartKeys: ["pushTime"], read: () => readMysConfig(root),
    async snapshot(config) {
      const { parseAnnouncementConfig } = await import("../plugins/notice/mys-announcement-config.ts");
      const { cron, maxNum, ban } = parseAnnouncementConfig(JSON.stringify(config));
      const values: Values = { pushTime: cron, maxNum };
      const words = record(config.banWord);
      for (const game of gameKeys) {
        const pattern = words?.[game];
        values[`${game}BanWord`] = typeof pattern === "string" ? pattern : ban[game]?.source ?? "";
        values[`${game}announceGroup`] = targetMapping(config[`${game}announceGroup`] ?? {});
        values[`${game}infoGroup`] = targetMapping(config[`${game}infoGroup`] ?? {});
      }
      for (const game of panelMysActivityGames) values[`${game}ActivityPush`] = targetMapping(config[`${game}ActivityPush`] ?? {});
      return values;
    },
    patch(changed, effective) {
      const updated: Configuration = { ...changed };
      const words = { ...record(effective.banWord) };
      for (const game of gameKeys) {
        const key = `${game}BanWord`;
        if (!Object.hasOwn(changed, key)) continue;
        words[game] = changed[key];
        updated.banWord = words;
        delete updated[key];
      }
      return updated;
    },
    async validate(config) {
      const { parseAnnouncementConfig } = await import("../plugins/notice/mys-announcement-config.ts");
      const parsed = parseAnnouncementConfig(JSON.stringify(config));
      if (!validateCron(parsed.cron)) throw new InvalidNoticeSettings();
    },
  });
}
