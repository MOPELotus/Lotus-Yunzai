import { constants, linkSync, renameSync, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, isScalar, parseDocument, Parser, Scalar, type Node, type YAMLMap } from "yaml";
import { checkinScheduleMinute, type CheckinScheduleConfig } from "./checkin-schedule-plan.ts";
import { lockFile } from "./file-lock.ts";
import { inheritLotusGlobalConfig } from "./lotus-global-config.ts";

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

function errno(cause: unknown) {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

async function named(file: string) {
  return lstat(file).catch((cause: unknown) => {
    if (errno(cause) !== "ENOENT") throw cause;
    return undefined;
  });
}

interface Location {
  readonly source: string;
  readonly file: string;
  readonly exists: boolean;
}

async function effectiveFile(root: URL): Promise<Location> {
  const primary = fileURLToPath(new URL("config/global.yaml", root));
  const legacy = fileURLToPath(new URL("config/config/global.yaml", root));
  for (const source of [primary, legacy]) {
    const state = await named(source);
    if (!state) continue;
    if (!state.isFile() && !state.isSymbolicLink()) error("config");
    const file = await realpath(source);
    if (!(await named(file))?.isFile()) error("config");
    return { source, file, exists: true };
  }
  const parent = await named(dirname(primary));
  const directory = parent ? await realpath(dirname(primary)) : join(await realpath(fileURLToPath(root)), "config");
  if (parent && !(await named(directory))?.isDirectory()) error("config");
  return { source: primary, file: join(directory, "global.yaml"), exists: false };
}

function sameLocation(a: Location, b: Location) {
  return a.source === b.source && a.file === b.file;
}

function sameState(a: Stats, b: Stats | undefined) {
  return b?.dev === a.dev && b.ino === a.ino && b.size === a.size && b.ctimeMs === a.ctimeMs && b.mtimeMs === a.mtimeMs &&
    b.mode === a.mode && b.uid === a.uid && b.gid === a.gid;
}

async function snapshot(location: Location) {
  if (!location.exists) return;
  const file = location.file;
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1) error("config");
    const bytes = await input.readFile();
    if (!sameState(stat, await input.stat()) || !sameState(stat, await named(file))) error("conflict");
    return { stat, bytes };
  } finally {
    await input.close();
  }
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
  function assertActive() {
    if (signal?.aborted) error("cancelled");
  }
  function authorize(document: Record<string, unknown>) {
    if (canWrite(structuredClone(document)) !== true) error("permission");
  }

  try {
    assertActive();
    const initial = await effectiveFile(root);
    if (!initial.exists && !await named(dirname(initial.file))) {
      authorize(await inheritLotusGlobalConfig(root, {}));
      await mkdir(dirname(initial.file), { mode: 0o700 }).catch((cause: unknown) => {
        if (errno(cause) !== "EEXIST") throw cause;
      });
    }
    const sidecar = join(dirname(initial.file), `.${basename(initial.file)}.lotus-global.sqlite`);
    const database = await lockFile(sidecar, "全局签到调度配置").catch(() => error("conflict"));
    try {
      assertActive();
      const location = await effectiveFile(root);
      if (!sameLocation(initial, location)) error("conflict");
      const current = await snapshot(location);
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current?.bytes);
      const previous = readDocument(content);
      const effective = await inheritLotusGlobalConfig(root, previous.config);
      const scheduler = validScheduler(effective.scheduler);
      authorize(effective);
      assertActive();
      async function verifySnapshot() {
        const active = await effectiveFile(root);
        if (!sameLocation(location, active) || location.exists !== active.exists) error("conflict");
        const latest = await snapshot(active);
        if (current && (!latest || !sameState(current.stat, latest.stat) || !current.bytes.equals(latest.bytes))) error("conflict");
        const latestEffective = await inheritLotusGlobalConfig(root, previous.config);
        if (!isDeepStrictEqual(effective, latestEffective)) error("conflict");
        assertActive();
      }
      if (scheduleFields.every(key => patch[key] === undefined || scheduler[key] === patch[key])) {
        await verifySnapshot();
        return scheduler;
      }
      const next = applyPatch(previous, patch);
      const nextScheduler = validScheduler({ ...scheduler, ...next.scheduler });

      const directory = await mkdtemp(join(dirname(location.file), ".lotus-schedule-settings-"));
      try {
        const staged = join(directory, "global.yaml");
        const output = await open(staged, "wx", 0o600);
        try {
          await output.writeFile(next.yaml, "utf8");
          if (current) {
            const owner = await output.stat();
            if (owner.uid !== current.stat.uid || owner.gid !== current.stat.gid) await output.chown(current.stat.uid, current.stat.gid);
            await output.chmod(current.stat.mode & 0o7777);
          }
          await output.sync();
        } finally {
          await output.close();
        }

        await verifySnapshot();
        if (current) renameSync(staged, location.file);
        else {
          try { linkSync(staged, location.file); }
          catch (cause) { if (errno(cause) === "EEXIST") error("conflict"); throw cause; }
        }
        return nextScheduler;
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      database.close();
    }
  } catch (cause) {
    if (cause instanceof CheckinScheduleSettingsError) throw cause;
    error("config");
  }
}
