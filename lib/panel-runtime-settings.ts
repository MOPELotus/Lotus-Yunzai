import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { readLocalConfig, readOptionalConfigFile } from "./config.ts";
import { fileShareDefaults } from "./file-to-url.ts";
import { isLogLevel, logLevels, type LogLevel } from "./log-level-command.ts";
import { logObjectOptions, type LogObjectOptions } from "./log-object-options.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { onlineNoticeSeconds } from "./online-notice.ts";
import { readPanelJson } from "./panel.ts";
import { defaultPluginLoadMs, maxPluginLoadMs, parsePluginLoadMilliseconds } from "./plugin-load-progress.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";

import { parseImageFooter, type ImageFooterConfig } from "../packages/skia/custom-footer.ts";

const restart = $t("lib.panel-runtime-settings.text_d3d0842647");
const reload = $t("lib.panel-runtime-settings.text_9550adf734");
const slash = "/→#";
const fields = [
  { key: "imageRenderPreset", label: $t("lib.panel-runtime-settings.text_fe562a50dd"), type: "select", hint: restart,
    options: [{ label: $t("lib.panel-runtime-settings.text_1724f1ad64"), value: "standard" }, { label: $t("lib.panel-runtime-settings.text_70f0fcd6b3"), value: "low" }] },
  { key: "imageFooter", label: $t("lib.panel-runtime-settings.footer-label"), type: "json", hint: $t("lib.panel-runtime-settings.footer-hint") },
  { key: "log_level", label: $t("lib.panel-runtime-settings.text_0f8effe393"), type: "select", hint: reload,
    options: logLevels.map(value => ({ label: value, value })) },
  { key: "log_length", label: $t("lib.panel-runtime-settings.text_edd613ccd8"), type: "number", min: 1, max: 32_000, hint: restart },
  { key: "log_object", label: $t("lib.panel-runtime-settings.text_c46da81035"), type: "json",
    hint: $t("lib.panel-runtime-settings.text_2ad4ab2c79") },
  { key: "log_align", label: $t("lib.panel-runtime-settings.text_77e3ebb25a"), type: "text", hint: $t("lib.panel-runtime-settings.text_fff8050bff") },
  { key: "plugin_load_timeout", label: $t("lib.panel-runtime-settings.text_a7c6e7e42e"), type: "number", min: 0, max: maxPluginLoadMs / 1000,
    hint: $t("lib.panel-runtime-settings.text_339f143408") },
  { key: slash, label: $t("lib.panel-runtime-settings.text_e796c28897"), type: "boolean", hint: reload },
  { key: "cache_group_member", label: $t("lib.panel-runtime-settings.text_5dbae9fd9e"), type: "boolean", hint: restart },
  { key: "msg_type_count", label: $t("lib.panel-runtime-settings.text_3b34617719"), type: "boolean", hint: restart },
  { key: "file_watch", label: $t("lib.panel-runtime-settings.text_0efc2b209f"), type: "boolean", hint: restart },
  { key: "online_msg_exp", label: $t("lib.panel-runtime-settings.text_62351d01df"), type: "number",
    min: 0, hint: $t("lib.panel-runtime-settings.text_2d6d6fc755") },
  { key: "file_to_url_time", label: $t("lib.panel-runtime-settings.text_a15439b360"), type: "number", min: 0,
    hint: $t("lib.panel-runtime-settings.text_fb71acb2ef") },
  { key: "file_to_url_times", label: $t("lib.panel-runtime-settings.text_05b5341eea"), type: "number", min: 0, nullable: true,
    hint: $t("lib.panel-runtime-settings.text_92c897308a") },
] as const;

interface RuntimeValues {
  imageRenderPreset: "low" | "standard";
  imageFooter: ImageFooterConfig;
  log_level: LogLevel;
  log_length: number;
  log_object: LogObject;
  log_align: string;
  plugin_load_timeout: number;
  [slash]: boolean;
  cache_group_member: boolean;
  msg_type_count: boolean;
  file_watch: boolean;
  online_msg_exp: number;
  file_to_url_time: number;
  file_to_url_times: number | null;
}

function enabled(value: unknown) {
  return value === true || value === 1;
}

type LogObject = boolean | LogObjectOptions | null;

function logObjectValue(value: unknown): LogObject {
  return typeof value === "boolean" ? value : logObjectOptions(value) ?? null;
}

async function readValues(root: URL): Promise<RuntimeValues> {
  const config = await readLocalConfig(root, "bot");
  const level = typeof config.log_level === "string" ? config.log_level.toLowerCase() : undefined;
  const length = typeof config.log_length === "string" || typeof config.log_length === "number" ? Number(config.log_length) : NaN;
  let slashEnabled = enabled(config[slash]);
  if (!Object.hasOwn(config, slash)) {
    try {
      const legacy = await readOptionalConfigFile(root, "config/config/bot.yaml");
      slashEnabled = legacy !== undefined && (!Object.hasOwn(legacy, slash) || enabled(legacy[slash]));
    } catch {
      slashEnabled = false;
    }
  }
  const { minutes, times } = fileShareDefaults(config);
  return {
    imageRenderPreset: config.imageRenderPreset === "low" ? "low" : "standard",
    imageFooter: parseImageFooter(config.imageFooter) ?? parseImageFooter(undefined)!,
    log_level: isLogLevel(level) ? level : "info",
    log_length: Number.isSafeInteger(length) && length > 0 ? Math.min(length, 32_000) : 10_000,
    log_object: logObjectValue(config.log_object),
    log_align: typeof config.log_align === "string" ? sanitizeRuntimeLog(config.log_align, 64) : "Lotus-Yunzai",
    plugin_load_timeout: config.plugin_load_timeout !== undefined && parsePluginLoadMilliseconds(config.plugin_load_timeout) !== undefined
      ? Number(config.plugin_load_timeout) : defaultPluginLoadMs / 1000,
    [slash]: slashEnabled,
    cache_group_member: config.cache_group_member === undefined || Boolean(config.cache_group_member),
    msg_type_count: enabled(config.msg_type_count) || config.msg_type_count === "1",
    file_watch: config.file_watch !== false,
    online_msg_exp: onlineNoticeSeconds(config.online_msg_exp) === undefined ? 0 :
      config.online_msg_exp === undefined ? 1440 : Number(config.online_msg_exp),
    file_to_url_time: minutes, file_to_url_times: times ?? null,
  };
}

function parseValues(input: unknown): RuntimeValues | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== fields.length || !fields.every(({ key }) => Object.hasOwn(input, key))) return;
  const values = input as Record<keyof RuntimeValues, unknown>;
  if ((values.imageRenderPreset !== "low" && values.imageRenderPreset !== "standard") ||
      !parseImageFooter(values.imageFooter) || !isDeepStrictEqual(values.imageFooter, parseImageFooter(values.imageFooter)) ||
      !isLogLevel(values.log_level) || typeof values.log_length !== "number" || !Number.isSafeInteger(values.log_length) ||
      values.log_length < 1 || values.log_length > 32_000 ||
      !isDeepStrictEqual(values.log_object, logObjectValue(values.log_object)) ||
      typeof values.log_align !== "string" || values.log_align !== sanitizeRuntimeLog(values.log_align, 64) ||
      typeof values.plugin_load_timeout !== "number" || parsePluginLoadMilliseconds(values.plugin_load_timeout) === undefined ||
      !([slash, "cache_group_member", "msg_type_count", "file_watch"] as const).every(key => typeof values[key] === "boolean") ||
      typeof values.online_msg_exp !== "number" ||
      (values.online_msg_exp !== 0 && onlineNoticeSeconds(values.online_msg_exp) === undefined) ||
      typeof values.file_to_url_time !== "number" || values.file_to_url_time < 0 ||
      values.file_to_url_time !== fileShareDefaults(values).minutes ||
      (values.file_to_url_times !== null && (typeof values.file_to_url_times !== "number" ||
        !Number.isSafeInteger(values.file_to_url_times) || values.file_to_url_times < 0))) return;
  return values as unknown as RuntimeValues;
}

export function panelRuntimeSettings(root: URL) {
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
      const previous = parseValues(body.previous), values = parseValues(body.values);
      if (!previous || !values) return new Response(null, { status: 400 });
      await updateLocalConfiguration(root, "bot", {
        signal: request.signal, canWrite: active, canCommit: active,
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
            expected[key] = values[key];
            document.set(key, values[key]);
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
