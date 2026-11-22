import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, parseDocument } from "yaml";
import { mergeLegacyStatusConfig } from "../plugins/system/status-background.ts";
import { statusMonitorSettings } from "../plugins/system/status-monitor.ts";
import { statusProbeSettings } from "../plugins/system/status-network-probes.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

type Config = Record<string, unknown>;
type FieldType = "boolean" | "number" | "text" | "select" | "list" | "json";
type Option = { label: string; value: string };
type Field = {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
  min?: number;
  max?: number;
  options?: readonly Option[];
  accepts(value: unknown): boolean;
};

const maxConfigBytes = 64 * 1024;
const restartHint = "保存后在下次宿主重启时生效。";
const resourceOrder = ["CPU", "RAM", "SWAP", "Bun", "GPU"];
const background = /^(?:random|[^./\\:\p{Cc}][^/\\:\p{Cc}]{0,180}\.(?:jpe?g|png|webp|gif|avif|bmp))$/iu;

function object(value: unknown): Config | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function booleanField(key: string, label: string, hint?: string): Field {
  return { key, label, type: "boolean", hint, accepts: value => typeof value === "boolean" };
}

function numberField(key: string, label: string, min: number, max: number, hint?: string): Field {
  return { key, label, type: "number", min, max, hint, accepts: value => integerIn(value, min, max) };
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function listField(key: string, label: string, hint?: string, options?: readonly Option[]): Field {
  return { key, label, type: "list", hint, options, accepts: value =>
    Array.isArray(value) && value.length <= (options?.length ?? 64) &&
    value.every(item => typeof item === "string" && item.length > 0 && item.length <= 96 && !/[\p{Cc}\p{Cf}]/u.test(item) &&
      (!options || options.some(option => option.value === item))) &&
    (!options || new Set(value).size === value.length) };
}

function cleanProbeSites(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 8).flatMap(value => {
    const row = object(value);
    if (typeof row?.name !== "string" || !row.name.trim() || row.name.length > 48 || /[\p{Cc}\p{Cf}]/u.test(row.name) ||
        typeof row.url !== "string") return [];
    const target = URL.parse(row.url);
    if (!target || target.search || target.hash || target.username || target.password) return [];
    const entry = { name: row.name, url: row.url, useProxy: row.useProxy === true };
    const settings = statusProbeSettings({ networkProbesEnabled: true, psTestSites: { show: true, list: [entry] } });
    return settings?.list.length === 1 ? [entry] : [];
  });
}

const orderOptions = [
  { label: "按内存", value: "mem" }, { label: "按 CPU", value: "cpu" }, { label: "CPU 与内存各半", value: "cpu_mem" },
] as const;
const fields: readonly Field[] = [
  booleanField("defaultState", "允许直接发送「状态」"),
  booleanField("noPro", "禁用状态 Pro"),
  booleanField("showFastFetch", "显示主机概况"),
  booleanField("showRedisInfo", "显示 Valkey 信息", "历史连接数采样在下次宿主重启时采用新设置。"),
  booleanField("closedChart", "隐藏状态 Pro 历史图表"),
  booleanField("chartsCfg.show", "显示网络历史图表"),
  listField("systemResources", "资源卡片及顺序", "可用项为 CPU、RAM、SWAP、Bun 和 GPU。",
    resourceOrder.map(value => ({ label: value, value }))),
  { key: "style.backdropDefault", label: "背景图文件名", type: "text", hint: "填 random 随机选择，或填写主题内现有文件名。",
    accepts: value => typeof value === "string" && background.test(value) },
  booleanField("monitor.open", "启用后台监控采样", restartHint),
  numberField("monitor.getDataInterval", "采样间隔（毫秒）", 1_000, 3_600_000, restartHint),
  numberField("monitor.saveDataNumber", "保留采样点数", 1, 720, restartHint),
  booleanField("monitor.openRedisSaveData", "在 Valkey 保留监控历史", restartHint),
  booleanField("processLoad.show", "显示进程负载"),
  booleanField("processLoad.showMax.show", "显示资源占用最高的进程"),
  numberField("processLoad.showMax.showNum", "高占用进程显示数量", 0, 16),
  { key: "processLoad.showMax.order", label: "高占用进程排序", type: "select", options: orderOptions,
    accepts: value => orderOptions.some(option => option.value === value) },
  listField("processLoad.list", "额外关注的进程名"),
  listField("processLoad.filterList", "忽略的进程名"),
  booleanField("networkProbesEnabled", "允许状态 Pro 测试公网网站"),
  booleanField("psTestSites.show", "显示网站测试结果"),
  numberField("psTestSites.timeout", "网站测试超时（毫秒）", 200, 5_000),
  numberField("psTestSites.concurNum", "同时测试的网站数量", 1, 5),
  { key: "psTestSites.list", label: "公网测试网站", type: "json",
    hint: '最多 8 个站点。每项包含 name、url 及 useProxy。填写不带账号、参数和片段的公网 HTTPS 地址。',
    accepts: value => isDeepStrictEqual(cleanProbeSites(value), value) },
];

function effectiveValues(config: Config) {
  const monitor = statusMonitorSettings(config);
  const process = object(config.processLoad);
  const top = object(process?.showMax);
  const charts = object(config.chartsCfg);
  const backdrop = object(config.style)?.backdropDefault;
  const probes = object(config.psTestSites);
  const names = (value: unknown) => (Array.isArray(value) ? value : []).filter(
    (entry): entry is string => typeof entry === "string" && !!entry.length && entry.length <= 96 &&
      !/[\p{Cc}\p{Cf}]/u.test(entry)).slice(0, 64);
  const resources = Array.isArray(config.systemResources)
    ? [...new Set(config.systemResources.map(name => name === "Node" ? "Bun" : name)
      .filter((name): name is string => typeof name === "string" && resourceOrder.includes(name)))]
    : resourceOrder;
  return {
    defaultState: config.defaultState === true,
    noPro: config.noPro === true,
    showFastFetch: config.showFastFetch !== false,
    showRedisInfo: config.showRedisInfo !== false,
    closedChart: config.closedChart === true,
    "chartsCfg.show": !charts || !Object.hasOwn(charts, "show") || charts.show === true || charts.show === "pro",
    systemResources: resources,
    "style.backdropDefault": typeof backdrop === "string" && background.test(backdrop) ? backdrop : "random",
    "monitor.open": monitor.enabled,
    "monitor.getDataInterval": monitor.interval,
    "monitor.saveDataNumber": monitor.limit,
    "monitor.openRedisSaveData": monitor.persist,
    "processLoad.show": process?.show !== false,
    "processLoad.showMax.show": top?.show !== false,
    "processLoad.showMax.showNum": typeof top?.showNum === "number" && Number.isSafeInteger(top.showNum)
      ? Math.max(0, Math.min(16, top.showNum)) : 6,
    "processLoad.showMax.order": top?.order === "cpu" || top?.order === "cpu_mem" ? top.order : "mem",
    "processLoad.list": names(process?.list),
    "processLoad.filterList": names(process?.filterList),
    networkProbesEnabled: config.networkProbesEnabled === true,
    "psTestSites.show": probes?.show === true || probes?.show === "pro",
    "psTestSites.timeout": integerIn(probes?.timeout, 200, 5_000) ? probes.timeout : 5_000,
    "psTestSites.concurNum": integerIn(probes?.concurNum, 1, 5) ? probes.concurNum : 5,
    "psTestSites.list": cleanProbeSites(probes?.list),
  };
}

async function readConfig(source: URL | string): Promise<Config> {
  const file = Bun.file(source);
  if (!await file.exists()) return {};
  if (file.size > maxConfigBytes) throw new GlobalConfigWriteError("config");
  const parsed: unknown = Bun.YAML.parse(await file.text());
  if (parsed == null) return {};
  const result = object(parsed);
  if (!result) throw new GlobalConfigWriteError("config");
  return result;
}

function editedYaml(text: string, local: Config, entries: readonly [string, unknown][]) {
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length || (document.contents && !isMap(document.contents))) throw new GlobalConfigWriteError("config");
  const expected = structuredClone(local);
  for (const [key, value] of entries) {
    const path = key.split(".");
    let target = expected;
    for (const [index, part] of path.slice(0, -1).entries()) {
      const ancestors = path.slice(0, index + 1);
      const node = document.getIn(ancestors, true);
      if (isAlias(node)) document.setIn(ancestors, document.createNode({ "<<": node.clone() }));
      else if (node !== undefined && !isMap(node)) throw new GlobalConfigWriteError("config");
      const nested = { ...object(target[part]) };
      target[part] = nested;
      target = nested;
    }
    document.setIn(path, value);
    target[path.at(-1)!] = value;
  }
  const yaml = document.toString({ lineWidth: 0 });
  if (Buffer.byteLength(yaml) > maxConfigBytes || !isDeepStrictEqual(Bun.YAML.parse(yaml), expected)) {
    throw new GlobalConfigWriteError("config");
  }
  return yaml;
}

function valid(input: unknown): input is Config {
  const data = object(input);
  return !!data && Object.keys(data).length === fields.length && fields.every(field =>
    Object.hasOwn(data, field.key) && field.accepts(data[field.key]));
}

export function panelStatusSettings(root: URL) {
  const view = fields.map(({ accepts: _validator, ...field }) => field);
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    const override = Bun.env.LOTUS_SYSTEM_STATUS_CONFIG ? resolve(Bun.env.LOTUS_SYSTEM_STATUS_CONFIG) : undefined;
    const current = override ?? new URL("config/system-status.yaml", root);
    const legacy = new URL("plugins/yenai-plugin/config/config/state.yaml", root);
    const effective = async (config: Config) =>
      override ? config : mergeLegacyStatusConfig(config, await readConfig(legacy).catch(() => undefined));
    const readEffective = async () => effective(await readConfig(current));
    if (request.method === "GET") {
      try {
        const values = effectiveValues(await readEffective());
        return active() ? Response.json({ fields: view, values }) : new Response(null, { status: 401 });
      } catch {
        return new Response(null, { status: 500 });
      }
    }

    const body = object(await readPanelJson(request).catch(() => undefined));
    if (!body || Object.keys(body).length !== 2 || !valid(body.previous) || !valid(body.values)) {
      return new Response(null, { status: 400 });
    }
    const { previous, values } = body;
    try {
      const saved = await updateLocalConfiguration(root, "system-status", {
        signal: request.signal, override, canWrite: active, canCommit: active, resolveEffective: readEffective,
        prepare(text, local, config) {
          if (Buffer.byteLength(text) > maxConfigBytes) throw new GlobalConfigWriteError("config");
          const seen = effectiveValues(config);
          if (!isDeepStrictEqual(seen, previous)) throw new GlobalConfigWriteError("conflict");
          const entries = Object.entries(values).filter(([key, value]) => !isDeepStrictEqual(value, previous[key]));
          return { yaml: entries.length ? editedYaml(text, local, entries) : undefined, value: values };
        },
      });
      return Response.json({ fields: view, values: saved });
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
