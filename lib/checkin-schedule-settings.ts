import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, isScalar, parseDocument, Parser, Scalar, type Node, type YAMLMap } from "yaml";
import { checkinScheduleMinute, type CheckinScheduleConfig } from "./checkin-schedule-plan.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";

export type CheckinScheduleSettingsChange =
  | { readonly type: "mode"; readonly mode: "random" }
  | { readonly type: "mode"; readonly mode: "fixed"; readonly time?: string }
  | { readonly type: "plan-cron"; readonly time: string };

interface SaveSettingsOptions {
  readonly canWrite: (document: Readonly<Record<string, unknown>>) => boolean;
  readonly signal?: AbortSignal;
}

type SettingsErrorReason = "invalid-input" | "permission" | "config" | "conflict" | "cancelled";

export class CheckinScheduleSettingsError extends Error {
  constructor(readonly reason: SettingsErrorReason) {
    super({
      "invalid-input": "请输入有效的签到模式或 H:MM 时间。",
      permission: "当前会话无权修改全局签到调度。",
      config: "全局签到调度配置无法安全读取或保存。",
      conflict: "全局签到调度配置正在更新，请稍后重试。",
      cancelled: "全局签到调度配置更新已取消。",
    }[reason]);
    this.name = "CheckinScheduleSettingsError";
  }
}

const scheduleFields = ["mode", "fixed_time", "plan_generate_cron"] as const;
type SchedulePatch = Partial<Record<typeof scheduleFields[number], string>>;

function error(reason: SettingsErrorReason): never {
  throw new CheckinScheduleSettingsError(reason);
}

function patchFor(change: CheckinScheduleSettingsChange): SchedulePatch {
  if (change?.type === "mode" && change.mode === "random") return { mode: "random" };
  if (change?.type === "mode" && change.mode === "fixed" && change.time === undefined) return { mode: "fixed" };
  if (change?.type !== "plan-cron" && (change?.type !== "mode" || change.mode !== "fixed")) error("invalid-input");
  if (typeof change.time !== "string" || !/^\d{1,2}:\d{2}$/u.test(change.time)) error("invalid-input");
  const time = change.time.padStart(5, "0");
  const minute = checkinScheduleMinute(time);
  if (!Number.isInteger(minute)) error("invalid-input");
  return change.type === "mode" ? { mode: "fixed", fixed_time: time } :
    { plan_generate_cron: `0 ${minute % 60} ${Math.floor(minute / 60)} * * ? *` };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function validOptionalBooleans(values: Record<string, unknown>, keys: readonly string[]) {
  return keys.every(key => !Object.hasOwn(values, key) || typeof values[key] === "boolean");
}

function checkWindow(value: unknown, start: string, end: string, booleans: readonly string[]) {
  if (value === undefined) return;
  const window = record(value);
  if (!window || !validOptionalBooleans(window, booleans)) error("config");
  const from = checkinScheduleMinute(Object.hasOwn(window, "window_start") ? window.window_start : start);
  const to = checkinScheduleMinute(Object.hasOwn(window, "window_end") ? window.window_end : end);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) error("config");
}

function validScheduler(input: unknown): CheckinScheduleConfig {
  if (input === undefined) return {};
  const scheduler = record(input);
  if (!scheduler || !validOptionalBooleans(scheduler, ["enable"])) error("config");
  if (Object.hasOwn(scheduler, "mode") && scheduler.mode !== "random" && scheduler.mode !== "fixed") error("config");
  if (Object.hasOwn(scheduler, "fixed_time") && !Number.isInteger(checkinScheduleMinute(scheduler.fixed_time))) error("config");
  for (const key of ["plan_generate_cron", "run_due_cron", "catch_up_cron"]) {
    const value = scheduler[key];
    if (Object.hasOwn(scheduler, key) && (typeof value !== "string" || !value.trim())) error("config");
  }
  checkWindow(scheduler.random, "00:00", "23:30", ["notify_before"]);
  checkWindow(scheduler.late_registration, "23:30", "23:59", ["enable", "notify"]);
  return scheduler as CheckinScheduleConfig;
}

function readDocument(text: string) {
  const document = parseDocument(text, { merge: true, strict: true, uniqueKeys: true, keepSourceTokens: true });
  const root = document.contents;
  const empty = !root || (isScalar(root) && root.value === null && !root.tag && !root.anchor &&
    root.range && root.range[0] === root.range[1]);
  if (document.errors.length || (!empty && !isMap(root))) error("config");
  const values: unknown = document.toJS({ mapAsMap: true });
  const runtime: unknown = Bun.YAML.parse(text);
  const config = runtime == null && empty ? {} : record(runtime);
  if (!config || (values !== null && !(values instanceof Map))) error("config");
  return {
    text, root: isMap(root) ? root : undefined, values: (values ?? new Map()) as Map<unknown, unknown>,
    config, scheduler: validScheduler(config.scheduler),
  };
}

interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function scalarText(key: string, value: string, node?: Node) {
  if (isScalar(node) && node.type === Scalar.QUOTE_SINGLE) return `'${value}'`;
  if (key === "mode" && (!node || (isScalar(node) && node.type === Scalar.PLAIN))) return value;
  return JSON.stringify(value);
}

function replaceScalar(text: string, key: string, value: string, node: Node): SourceEdit {
  if (!node.range || (!isScalar(node) && !isAlias(node))) error("config");
  const [start, end] = node.range;
  const token = node.srcToken;
  let replacement = scalarText(key, value, node);
  if (token?.type === "block-scalar") {
    const header = token.props[0];
    if (header?.type !== "block-scalar-header") error("config");
    // Keep the block indicator's inline comment and line ending when replacing its body.
    replacement += text.slice(header.offset + header.source.length, end - token.source.length);
  }
  return { start, end, value: replacement };
}

function insertPairs(text: string, map: YAMLMap | undefined,
  pairs: readonly { readonly key: string; readonly flow: string; readonly block: readonly string[] }[]): SourceEdit {
  const token = map?.srcToken;
  if (map && token?.type === "flow-collection") {
    const start = token.start.offset + token.start.source.length;
    const value = pairs.map(pair => `${pair.key}: ${pair.flow}`).join(", ");
    return { start, end: start, value: map.items.length ? `${value}, ` : value };
  }

  if (map && (token?.type !== "block-map" || !map.range)) error("config");
  const indent = " ".repeat(token?.type === "block-map" ? token.indent : 0);
  const eol = /\r?\n/u.exec(text)?.[0] ?? "\n";
  const start = map?.range?.[1] ?? [...new Parser().parse(text)].find(item => item.type === "doc-end")?.offset ?? text.length;
  const before = text.slice(0, start);
  const prefix = !before || before === "\uFEFF" || before.endsWith("\n") ? "" : eol;
  const suffix = start === text.length && prefix ? "" : eol;
  const body = pairs.flatMap(pair => pair.block).map(line => indent + line).join(eol);
  return { start, end: start, value: prefix + body + suffix };
}

function applyPatch(current: ReturnType<typeof readDocument>, patch: SchedulePatch) {
  const { text, root, values, config } = current;
  const original = values.get("scheduler");
  const node = root?.get("scheduler", true);
  if (original !== undefined && (!(original instanceof Map) || !isMap(node))) error("config");
  const expectedValues = new Map(values);
  const expectedScheduler = new Map(original as Map<unknown, unknown> | undefined);
  const expectedConfig = { ...config, scheduler: { ...current.scheduler, ...patch } };
  const edits: SourceEdit[] = [];
  const additions: { key: string; flow: string; block: string[] }[] = [];
  for (const [key, value] of Object.entries(patch)) {
    expectedScheduler.set(key, value);
    if (original instanceof Map && original.get(key) === value) continue;
    const scalar = isMap(node) ? node.get(key, true) : undefined;
    if (isNode(scalar)) {
      edits.push(replaceScalar(text, key, value, scalar));
    } else {
      const flow = scalarText(key, value);
      additions.push({ key, flow, block: [`${key}: ${flow}`] });
    }
  }
  if (additions.length) {
    if (isMap(node)) edits.push(insertPairs(text, node, additions));
    else {
      const flow = additions.flatMap(pair => pair.block).join(", ");
      edits.push(insertPairs(text, root, [{
        key: "scheduler", flow: `{${flow}}`, block: ["scheduler:", ...additions.flatMap(pair => pair.block.map(line => `  ${line}`))],
      }]));
    }
  }
  expectedValues.set("scheduler", expectedScheduler);
  const yaml = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((source, edit) => source.slice(0, edit.start) + edit.value + source.slice(edit.end), text);
  const next = readDocument(yaml);
  if (!isDeepStrictEqual(next.values, expectedValues) || !isDeepStrictEqual(next.config, expectedConfig)) error("config");
  return { yaml, scheduler: next.scheduler };
}

export async function persistCheckinScheduleSettings(root: URL, change: CheckinScheduleSettingsChange,
  { canWrite, signal }: SaveSettingsOptions): Promise<CheckinScheduleConfig> {
  const patch = patchFor(change);
  try {
    return await updateLotusGlobalConfig(root, {
      canWrite(document) {
        validScheduler(document.scheduler);
        return canWrite(document);
      },
      signal,
      prepare(content, _local, effective) {
        const previous = readDocument(content);
        const scheduler = validScheduler(effective.scheduler);
        if (scheduleFields.every(key => patch[key] === undefined || scheduler[key] === patch[key])) {
          return { value: scheduler };
        }
        const next = applyPatch(previous, patch);
        return { yaml: next.yaml, value: validScheduler({ ...scheduler, ...next.scheduler }) };
      },
    });
  } catch (cause) {
    if (cause instanceof GlobalConfigWriteError) error(cause.reason);
    if (cause instanceof CheckinScheduleSettingsError) throw cause;
    error("config");
  }
}
