import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, isScalar, parseDocument, Scalar, type Node } from "yaml";
import { checkinScheduleMinute, type CheckinScheduleConfig } from "./checkin-schedule-plan.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type SourceEdit, type Pair } from "./yaml-source-edits.ts";
import { defaultCheckinCrons, validCheckinCron } from "./checkin-schedule-runtime.ts";
import { scheduleCronFields, scheduleWindowFields, type CheckinSchedulePanelSettings, type CheckinSchedulePanelSnapshot,
  type LateScheduleSettings, type RandomScheduleSettings } from "./panel-checkin-schedule-schema.ts";

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
      "invalid-input": $t("lib.checkin-schedule-settings.text_a8435872fc"),
      permission: $t("lib.checkin-schedule-settings.text_bc7057bbf6"),
      config: $t("lib.checkin-schedule-settings.text_7700bf77e9"),
      conflict: $t("lib.checkin-schedule-settings.text_bea0909fc6"),
      cancelled: $t("lib.checkin-schedule-settings.text_f8b11ef99a"),
    }[reason]);
    this.name = "CheckinScheduleSettingsError";
  }
}

const scheduleFields = ["mode", "fixed_time", "enable", ...scheduleCronFields] as const;
type ScheduleWindowSection = keyof typeof scheduleWindowFields;
type ScalarPatch = Partial<Omit<CheckinSchedulePanelSettings, ScheduleWindowSection>>;
type SchedulePatch = ScalarPatch & { random?: Partial<RandomScheduleSettings>; late_registration?: Partial<LateScheduleSettings> };

const scheduleWindows = ["random", "late_registration"] as const;

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
    if (Object.hasOwn(scheduler, key) && typeof value !== "string") error("config");
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

function scalarText(key: string, value: string | boolean, node?: Node) {
  if (typeof value === "boolean") return String(value);
  if (isScalar(node) && node.type === Scalar.QUOTE_SINGLE) return `'${value}'`;
  if (key === "mode" && (!node || (isScalar(node) && node.type === Scalar.PLAIN))) return value;
  return JSON.stringify(value);
}

function replaceScalar(text: string, key: string, value: string | boolean, node: Node): SourceEdit {
  return replaceSourceScalar(text, node, scalarText(key, value, node));
}

function applyPatch(current: ReturnType<typeof readDocument>, patch: ScalarPatch) {
  const { text, root, values, config } = current;
  const original = values.get("scheduler");
  const node = root?.get("scheduler", true);
  if (original !== undefined && (!(original instanceof Map) || (!isMap(node) && !isAlias(node)))) error("config");
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
    if (isMap(node)) edits.push(insertSourcePairs(text, node, additions));
    // Inherit the shared mapping and override only the selected scheduler settings.
    else if (isAlias(node)) edits.push(sourceAliasOverrides(text, node, additions));
    else {
      const flow = additions.flatMap(pair => pair.block).join(", ");
      edits.push(insertSourcePairs(text, root, [{
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
        const { yaml, settings } = patchScheduler(content, effective.scheduler, patch);
        return { yaml, value: settings };
      },
    });
  } catch (cause) {
    if (cause instanceof GlobalConfigWriteError) error(cause.reason);
    if (cause instanceof CheckinScheduleSettingsError) throw cause;
    error("config");
  }
}

function visibleWindows({ random, late_registration: late }: CheckinScheduleConfig) {
  return {
    random: {
      window_start: random?.window_start ?? "00:00", window_end: random?.window_end ?? "23:30",
      notify_before: random?.notify_before ?? true,
    },
    late_registration: {
      window_start: late?.window_start ?? "23:30", window_end: late?.window_end ?? "23:59",
      enable: late?.enable ?? true, notify: late?.notify ?? true,
    },
  };
}

function applyWindowPatch(current: ReturnType<typeof readDocument>, section: ScheduleWindowSection,
  patch: Readonly<Record<string, string | boolean>>, inherited: Readonly<Record<string, unknown>>,
) {
  const { text, root, values, config } = current;
  const original = values.get("scheduler");
  const parent = root?.get("scheduler", true);
  if (original !== undefined && (!(original instanceof Map) || (!isMap(parent) && !isAlias(parent)))) error("config");
  const expectedScheduler = new Map(original as Map<unknown, unknown> | undefined);
  const originalWindow = expectedScheduler.get(section);
  const node = isMap(parent) ? parent.get(section, true) : undefined;
  if (originalWindow !== undefined && !(originalWindow instanceof Map)) error("config");
  if (node !== undefined && !isMap(node) && !isAlias(node)) error("config");

  // A newly added local window shadows the whole old window. Keep the inherited
  // values used by the scheduler and leave any unrelated legacy fields in the source file.
  const expectedWindow = new Map((originalWindow as Map<unknown, unknown> | undefined) ?? Object.entries(inherited));
  const edits: SourceEdit[] = [];
  const additions: Pair[] = [];
  for (const [key, value] of Object.entries(patch)) {
    expectedWindow.set(key, value);
    const scalar = isMap(node) ? node.get(key, true) : undefined;
    if (isNode(scalar)) edits.push(replaceScalar(text, key, value, scalar));
    else {
      const flow = scalarText(key, value);
      additions.push({ key, flow, block: [`${key}: ${flow}`] });
    }
  }

  if (additions.length) {
    if (isMap(node)) edits.push(insertSourcePairs(text, node, additions));
    else if (isAlias(node)) edits.push(sourceAliasOverrides(text, node, additions));
    else {
      const pair = sourceMappingPair(section, expectedWindow);
      if (isMap(parent)) edits.push(insertSourcePairs(text, parent, [pair]));
      else if (isAlias(parent)) edits.push(sourceAliasOverrides(text, parent, [pair]));
      else edits.push(insertSourcePairs(text, root, [sourceMappingPair("scheduler", new Map([[section, expectedWindow]]))]));
    }
  }
  const yaml = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.value + result.slice(edit.end), text);
  expectedScheduler.set(section, expectedWindow);
  const expectedValues = new Map(values).set("scheduler", expectedScheduler);
  const expectedConfig = { ...config, scheduler: { ...current.scheduler, [section]: Object.fromEntries(expectedWindow) } };
  const next = readDocument(yaml);
  if (!isDeepStrictEqual(next.values, expectedValues) || !isDeepStrictEqual(next.config, expectedConfig)) error("config");
  return next;
}

function patchScheduler(content: string, source: unknown, patch: SchedulePatch) {
  let current = readDocument(content);
  const scheduler = validScheduler(source);
  const previousWindows = visibleWindows(scheduler);
  const { random, late_registration, ...scalars } = patch;
  const windows = { random, late_registration };

  for (const section of scheduleWindows) {
    if (!windows[section]) continue;
    const { window_start, window_end } = { ...previousWindows[section], ...windows[section] };
    if (checkinScheduleMinute(window_start) > checkinScheduleMinute(window_end)) error("invalid-input");
  }

  if (scheduleFields.some(key => scalars[key] !== undefined && scheduler[key] !== scalars[key])) {
    current = readDocument(applyPatch(current, scalars).yaml);
  }
  for (const section of scheduleWindows) {
    const changes = windows[section];
    if (!changes) continue;
    const visible = previousWindows[section] as Record<string, unknown>;
    const changed = Object.fromEntries(Object.entries(changes).filter(([key, value]) => visible[key] !== value));
    if (!Object.keys(changed).length) continue;
    const inherited = Object.fromEntries(Object.entries(scheduler[section] ?? {})
      .filter(([key]) => (scheduleWindowFields[section] as readonly string[]).includes(key)));
    current = applyWindowPatch(current, section, changed, inherited);
  }
  const settings = validScheduler({ ...scheduler, ...current.scheduler });
  return { yaml: current.text === content ? undefined : current.text, settings };
}

export function checkinSchedulePanelSnapshot(source: unknown): CheckinSchedulePanelSnapshot {
  const current = validScheduler(source);
  const settings: CheckinSchedulePanelSettings = {
    enable: current.enable !== false,
    mode: current.mode ?? "random",
    fixed_time: current.fixed_time ?? "04:30",
    ...defaultCheckinCrons,
    ...visibleWindows(current),
  };
  const invalidCrons: CheckinSchedulePanelSnapshot["invalidCrons"][number][] = [];
  for (const key of scheduleCronFields) {
    const value = current[key]?.trim();
    if (!value) continue;
    if (validCheckinCron(value)) settings[key] = value;
    else invalidCrons.push(key);
  }
  const revision = createHash("sha256").update(JSON.stringify([settings, invalidCrons])).digest("hex");
  return { revision, settings, invalidCrons };
}

export function parseCheckinSchedulePanelPatch(input: unknown): SchedulePatch {
  const source = record(input);
  const accepted: readonly string[] = [...scheduleFields, ...scheduleWindows];
  if (!source || !Object.keys(source).length || Object.keys(source).some(key => !accepted.includes(key))) error("invalid-input");
  const patch: SchedulePatch = {};
  if (Object.hasOwn(source, "enable")) {
    if (typeof source.enable !== "boolean") error("invalid-input");
    patch.enable = source.enable;
  }
  if (Object.hasOwn(source, "mode")) {
    if (source.mode !== "fixed" && source.mode !== "random") error("invalid-input");
    patch.mode = source.mode;
  }
  if (Object.hasOwn(source, "fixed_time")) {
    if (typeof source.fixed_time !== "string" || !Number.isInteger(checkinScheduleMinute(source.fixed_time))) error("invalid-input");
    patch.fixed_time = source.fixed_time;
  }
  for (const key of scheduleCronFields) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (typeof value !== "string" || (value.trim() && !validCheckinCron(value))) error("invalid-input");
    patch[key] = value.trim() || defaultCheckinCrons[key];
  }
  for (const section of scheduleWindows) {
    if (!Object.hasOwn(source, section)) continue;
    const fields: readonly string[] = scheduleWindowFields[section];
    const values = record(source[section]);
    if (!values || !Object.keys(values).length) error("invalid-input");
    for (const [key, value] of Object.entries(values)) {
      if (!fields.includes(key)) error("invalid-input");
      if (key === "window_start" || key === "window_end") {
        if (typeof value !== "string" || !Number.isInteger(checkinScheduleMinute(value))) error("invalid-input");
      } else if (typeof value !== "boolean") error("invalid-input");
    }
    if (section === "random") patch.random = values as Partial<RandomScheduleSettings>;
    else patch.late_registration = values as Partial<LateScheduleSettings>;
  }
  return patch;
}

export function persistCheckinSchedulePanelSettings(root: URL, revision: string, patch: SchedulePatch,
  { canWrite, signal }: { readonly canWrite: () => boolean; readonly signal: AbortSignal },
) {
  const authorize = () => !signal.aborted && canWrite();
  return updateLotusGlobalConfig(root, {
    canWrite: authorize,
    canCommit: authorize,
    signal,
    prepare(content, _local, effective) {
      if (checkinSchedulePanelSnapshot(effective.scheduler).revision !== revision) throw new GlobalConfigWriteError("conflict");
      const { yaml, settings } = patchScheduler(content, effective.scheduler, patch);
      return { yaml, value: checkinSchedulePanelSnapshot(settings) };
    },
  });
}
