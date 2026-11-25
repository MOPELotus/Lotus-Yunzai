import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { withDefaultUpdateSchedule } from "./update-schedule-settings.ts";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { readLocalConfig } from "./config.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { normalizedUpdateNoticeCron, readUpdateNoticeSettings, type UpdateNoticeSettings } from "./update-notice.ts";

const cronHint = $t("lib.panel-process-schedule-settings.text_6099192357");
const updateHint = $t("lib.panel-process-schedule-settings.text_2a919b9185");
const restartHint = $t("lib.panel-process-schedule-settings.text_77fbc7f13e");
const cronKeys = ["update_cron", "restart_cron", "stop_cron", "start_cron"] as const;
const timerKeys = ["update_time", "restart_time"] as const;
const fields = [
  { key: "update_time", label: $t("lib.panel-process-schedule-settings.text_0cc4dc309d"), type: "number", min: 0,
    hint: $t("lib.panel-process-schedule-settings.text_858327e51b") + updateHint },
  { key: "update_cron", label: $t("lib.panel-process-schedule-settings.text_2cfde8b8be"), type: "list", separator: "line", hint: cronHint + updateHint },
  { key: "update_notice", label: $t("lib.panel-process-schedule-settings.text_fc76528d42"), type: "boolean",
    hint: $t("lib.panel-process-schedule-settings.text_f3e672dd2d") },
  { key: "update_notice_cron", label: $t("lib.panel-process-schedule-settings.text_045555a570"), type: "text",
    hint: $t("lib.panel-process-schedule-settings.text_3de8f1f30d") },
  { key: "restart_time", label: $t("lib.panel-process-schedule-settings.text_b3835c01a2"), type: "number", min: 0,
    hint: $t("lib.panel-process-schedule-settings.text_c72935d64a") + restartHint },
  { key: "restart_cron", label: $t("lib.panel-process-schedule-settings.text_562788fd33"), type: "list", separator: "line", hint: cronHint + restartHint },
  { key: "stop_cron", label: $t("lib.panel-process-schedule-settings.text_59e9cd3477"), type: "list", separator: "line", hint: cronHint },
  { key: "start_cron", label: $t("lib.panel-process-schedule-settings.text_98be512b03"), type: "list", separator: "line", hint: cronHint },
] as const;

type Values = Record<typeof timerKeys[number], number> & Record<typeof cronKeys[number], string[]> & UpdateNoticeSettings;
const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;

function validMinutes(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && Number.isSafeInteger(Math.ceil(value * 60_000));
}

function minutes(value: unknown, allowExponent: boolean) {
  const parsed = typeof value === "string" && (allowExponent || decimal.test(value.trim())) ? Number(value) : value;
  return validMinutes(parsed) ? parsed : 0;
}

function expressions(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && !!item.trim());
}

async function readValues(root: URL): Promise<Values> {
  const config = withDefaultUpdateSchedule(await readLocalConfig(root, "bot"));
  return {
    ...readUpdateNoticeSettings(config),
    update_time: minutes(config.update_time, false),
    restart_time: minutes(config.restart_time, true),
    update_cron: expressions(config.update_cron),
    restart_cron: expressions(config.restart_cron),
    stop_cron: expressions(config.stop_cron),
    start_cron: expressions(config.start_cron),
  };
}

function valuesOf(input: unknown): Values | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== fields.length || !fields.every(({ key }) => Object.hasOwn(input, key))) return;
  const record = input as Record<keyof Values, unknown>;
  if (typeof record.update_notice !== "boolean" || typeof record.update_notice_cron !== "string" || !timerKeys.every(key => validMinutes(record[key])) || !cronKeys.every(key => {
    const array = record[key];
    return Array.isArray(array) && array.every(item => typeof item === "string");
  })) return;
  return record as unknown as Values;
}

function validCron(expressions: string[], validate: (cron: string) => boolean) {
  return expressions.length <= 64 && expressions.every(expression => {
    if (expression.length > 160 || /[\r\n]/u.test(expression)) return false;
    const cron = expression.trim().replace(/\s+/gu, " ");
    const count = cron.split(" ").length;
    return (count === 5 || count === 6) && validate(cron);
  });
}

export function panelProcessScheduleSettings(root: URL, validateCron: (cron: string) => boolean,
  applyNotice?: (settings: UpdateNoticeSettings) => void,
) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      if (request.method === "GET") {
        const values = await readValues(root);
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      }
      const body = await readPanelJson(request).catch(() => undefined);
      if (!body || typeof body !== "object" || !("previous" in body) || !("values" in body)) {
        return new Response(null, { status: 400 });
      }
      const previous = valuesOf(body.previous), values = valuesOf(body.values);
      if (!previous || !values || !cronKeys.every(key =>
        isDeepStrictEqual(previous[key], values[key]) || validCron(values[key], validateCron))) {
        return new Response(null, { status: 400 });
      }
      const noticeChanged = previous.update_notice !== values.update_notice || previous.update_notice_cron !== values.update_notice_cron;
      if (noticeChanged && (values.update_notice || previous.update_notice_cron !== values.update_notice_cron)) {
        const cron = normalizedUpdateNoticeCron(values.update_notice_cron);
        if (!cron || !validateCron(cron)) return new Response(null, { status: 400 });
        Object.assign(values, { update_notice_cron: cron });
      }
      await updateLocalConfiguration(root, "bot", {
        signal: request.signal, canWrite: active, canCommit: active,
        onCommitted: noticeChanged ? () => applyNotice?.({
          update_notice: values.update_notice, update_notice_cron: values.update_notice_cron,
        }) : undefined,
        resolveEffective: async () => ({ ...await readValues(root) }),
        prepare(content, local, current) {
          if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
          const changed = fields.filter(({ key }) => !isDeepStrictEqual(current[key], values[key]));
          if (!changed.length) return { value: undefined };
          const document = parseDocument(content, { strict: true, uniqueKeys: true, merge: true });
          if (document.errors.length || (document.contents && !isMap(document.contents))) {
            throw new GlobalConfigWriteError("config");
          }
          const expected = { ...local };
          for (const { key } of changed) {
            const value = values[key];
            const stored = !Array.isArray(value) ? value : value.length === 0 ? false : value.length === 1 ? value[0]! : value;
            expected[key] = stored;
            document.set(key, stored);
          }
          const yaml = document.toString({ lineWidth: 0 });
          if (!isDeepStrictEqual(Bun.YAML.parse(yaml), expected)) throw new GlobalConfigWriteError("config");
          return { yaml, value: undefined };
        },
      });
      return Response.json({ fields, values });
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && error.reason === "permission") {
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
