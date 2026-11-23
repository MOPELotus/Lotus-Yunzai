import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { readLocalConfig, readOptionalConfigFile } from "./config.ts";
import { fileShareDefaults } from "./file-to-url.ts";
import { isLogLevel, logLevels, type LogLevel } from "./log-level-command.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { onlineNoticeSeconds } from "./online-notice.ts";
import { readPanelJson } from "./panel.ts";
import { defaultPluginLoadMs, maxPluginLoadMs, parsePluginLoadMilliseconds } from "./plugin-load-progress.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";

const restart = "保存后重启宿主生效。";
const reload = "配置监听开启时自动生效；关闭监听时，重启宿主生效。";
const slash = "/→#";
const fields = [
  { key: "imageRenderPreset", label: "图片渲染档位", type: "select", hint: restart,
    options: [{ label: "标准（4×）", value: "standard" }, { label: "低配（1×）", value: "low" }] },
  { key: "log_level", label: "日志等级", type: "select", hint: reload,
    options: logLevels.map(value => ({ label: value, value })) },
  { key: "log_length", label: "日志单段字符上限", type: "number", min: 1, max: 32_000, hint: restart },
  { key: "log_object", label: "日志对象格式", type: "json",
    hint: "填 false 简化对象输出，或设置 length、depth、maxArrayLength、maxStringLength。留空使用默认。保存后重启宿主生效。" },
  { key: "log_align", label: "日志标签对齐", type: "text", hint: "标签最多 64 个字符。留空取消对齐。保存后重启宿主生效。" },
  { key: "plugin_load_timeout", label: "单个插件加载超时（秒）", type: "number", min: 0, max: maxPluginLoadMs / 1000,
    hint: "默认 60 秒，填 0 时立即触发加载超时。保存后重启宿主生效。" },
  { key: slash, label: "识别斜线命令前缀", type: "boolean", hint: reload },
  { key: "cache_group_member", label: "上线预缓存群成员", type: "boolean", hint: restart },
  { key: "msg_type_count", label: "统计消息段类型", type: "boolean", hint: restart },
  { key: "file_watch", label: "监听配置文件改动", type: "boolean", hint: restart },
  { key: "online_msg_exp", label: "主人上线通知冷却（分钟）", type: "number",
    min: 0, hint: "填 0 关闭上线通知。保存后重启宿主生效。" },
  { key: "file_to_url_time", label: "文件分享有效期（分钟）", type: "number", min: 0,
    hint: "默认 1 分钟，支持小数。填 0 时链接不随时间失效。保存后重启宿主生效。" },
  { key: "file_to_url_times", label: "文件分享下载次数", type: "number", min: 0, nullable: true,
    hint: "留空不限次数，填 0 时按默认策略生成的链接不可下载。HEAD 探测不计入。保存后重启宿主生效。" },
] as const;

interface RuntimeValues {
  imageRenderPreset: "low" | "standard";
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

const objectLimits = { length: 32_000, depth: 10, maxArrayLength: 100, maxStringLength: 1_000 } as const;
type LogObjectKey = keyof typeof objectLimits;
type LogObject = boolean | null | Partial<Record<LogObjectKey, number>>;

function logObjectValue(value: unknown): LogObject {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const options = value as Record<string, unknown>;
  const result: Partial<Record<LogObjectKey, number>> = {};
  for (const key of Object.keys(objectLimits) as LogObjectKey[]) {
    const option = options[key];
    const number = key === "length" && typeof option === "string" ? Number(option) : option;
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= (key === "length" ? 1 : 0)) {
      result[key] = Math.min(number, objectLimits[key]);
    }
  }
  return result;
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
