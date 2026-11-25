import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { logObjectOptions } from "./log-object-options.ts";
import { readOwnerSnapshot } from "./permissions.ts";
import type { UpdateNoticeSettings } from "./update-notice.ts";

type Config = Record<string, unknown>;
type ConfigName = "other" | "bot";
type Scalar = boolean | number | string | null;
type DeferredOwners = { master: Exclude<Scalar, null>[]; masterQQ: Exclude<Scalar, null>[] };

const otherFields = [
  "master", "masterQQ", "disablePrivate", "disableMsg", "disableAdopt", "whiteGroup", "whiteUser", "blackGroup", "blackUser",
  "autoFriend", "autoGroup", "autoQuit",
] as const;
const botFields = [
  "/→#", "update_time", "restart_time", "update_cron", "update_notice", "update_notice_cron", "restart_cron", "stop_cron", "start_cron", "file_watch",
  "cache_group_member", "online_msg_exp", "plugin_load_timeout", "log_level", "log_length", "log_object", "log_align",
  "msg_type_count", "file_to_url_time", "file_to_url_times",
] as const;
const inheritedOther = {
  master: ["stdin:stdin"], blackGroup: [213_938_015], blackUser: [528_952_540],
} as const;
const listFields = new Set<string>(["master", "masterQQ", "disableAdopt", "whiteGroup", "whiteUser", "blackGroup", "blackUser",
  "update_cron", "restart_cron", "stop_cron", "start_cron"]);
const maximumConfigBytes = 16 * 1024 * 1024;

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function scalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function ownerEntries(value: unknown): Exclude<Scalar, null>[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is Exclude<Scalar, null> => scalar(item) && item !== null,
  );
}

function positiveSafeId(value: string | number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

function partitionOwners(config: Config, deferred: DeferredOwners) {
  // The legacy loader matched the raw bot and user IDs. Only exact numeric
  // bindings and the literal terminal identity can be activated on this host.
  config.master = ownerEntries(config.master).filter(entry => {
    const numeric = typeof entry === "string" ? /^([1-9]\d*):([1-9]\d*)$/u.exec(entry) : null;
    if (entry === "stdin:stdin" || (numeric && positiveSafeId(numeric[1]!) && positiveSafeId(numeric[2]!))) return true;
    deferred.master.push(entry);
    return false;
  });
  if (!Object.hasOwn(config, "masterQQ")) return;
  config.masterQQ = ownerEntries(config.masterQQ).filter(entry => {
    if (entry === "stdin" || (typeof entry === "number" && positiveSafeId(entry)) ||
        (typeof entry === "string" && /^\d+$/u.test(entry.trim()) && positiveSafeId(entry))) return true;
    deferred.masterQQ.push(entry);
    return false;
  });
}

function projectConfig(config: Config, name: ConfigName, deferred: DeferredOwners) {
  // Only defaults read differently by the normalized host need materialization.
  // Request defaults still come from its legacy overlay, with original YAML scalar types.
  const selected: Config = name === "other" ? { ...inheritedOther } : {};
  for (const key of name === "other" ? otherFields : botFields) {
    if (!Object.hasOwn(config, key)) continue;
    const value = config[key];
    if (key === "log_object" && value != null && typeof value === "object" && !Array.isArray(value)) {
      selected[key] = logObjectOptions(value);
      continue;
    }
    if (!scalar(value) && !(listFields.has(key) && Array.isArray(value) && value.every(scalar))) {
      throw new Error($t("lib.migration-core-config.text_af3fdc05cc", { "name": name, "key": key }));
    }
    switch (key) {
      case "/→#": selected[key] = Boolean(value); break;
      case "log_align": selected[key] = value || ""; break;
      case "autoFriend": selected[key] = Number(value) === 1 ? 1 : 0; break;
      case "autoQuit": {
        const threshold = Math.floor(Number(value));
        selected[key] = Number.isFinite(threshold) && threshold > 0 ? Math.min(threshold, Number.MAX_SAFE_INTEGER) : 0;
        break;
      }
      case "disableAdopt":
        selected[key] = Array.isArray(value) ? value.filter(item => item != null && item !== "").map(String) : [];
        break;
      default: selected[key] = value;
    }
  }
  if (name === "other") {
    partitionOwners(selected, deferred);
    readOwnerSnapshot(selected);
  }
  return selected;
}

function same(expected: Stats, actual: Stats) {
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

async function physicalDirectory(path: string) {
  try {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
      throw new Error($t("lib.migration-core-config.text_77152546f5"));
    }
    return true;
  } catch (error) {
    if (!missing(error)) throw error;
    return false;
  }
}

async function readConfig(directory: string, name: ConfigName): Promise<Config | undefined> {
  const path = join(directory, `${name}.yaml`);
  const original = await lstat(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (!original) return;
  if (!original.isFile() || original.nlink !== 1 || await realpath(path) !== path) {
    throw new Error($t("lib.migration-core-config.text_e0acff1fb1"));
  }
  if (original.size > maximumConfigBytes) throw new Error($t("lib.migration-core-config.text_fdeb0dcd0f"));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(original, await file.stat())) throw new Error($t("lib.migration-core-config.text_dd9c804c8e"));
    const bytes = Buffer.alloc(original.size);
    for (let position = 0; position < bytes.length;) {
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) throw new Error($t("lib.migration-core-config.text_dd9c804c8e"));
      position += bytesRead;
    }
    if (!same(original, await file.stat()) || !same(original, await lstat(path)) || await realpath(path) !== path) {
      throw new Error($t("lib.migration-core-config.text_dd9c804c8e"));
    }
    let decoded: unknown;
    try { decoded = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error($t("lib.migration-core-config.text_4b79ac1a52", { "name": name })); }
    if (decoded != null && (typeof decoded !== "object" || Array.isArray(decoded))) {
      throw new Error($t("lib.migration-core-config.text_4b79ac1a52", { "name": name }));
    }
    return (decoded ?? {}) as Config;
  } finally {
    await file.close();
  }
}

async function stagingDirectory(target: string, segments: readonly string[]) {
  let parent = target;
  for (const segment of segments) {
    parent = join(parent, segment);
    if (!await physicalDirectory(parent)) await mkdir(parent, { mode: 0o700 });
    if (!await physicalDirectory(parent)) throw new Error($t("lib.migration-core-config.text_e31f7d92b8"));
  }
  return parent;
}

export async function stageLegacyCoreConfig(sourcePath: string, stateDirectory: string, signal?: AbortSignal,
  updateNotice?: Partial<UpdateNoticeSettings>,
) {
  signal?.throwIfAborted();
  const [source, target] = await Promise.all([realpath(sourcePath), realpath(stateDirectory)]);
  const local = relative(source, target);
  if (!isAbsolute(local) && local !== ".." && !local.startsWith(".." + sep)) {
    throw new Error($t("lib.migration-core-config.text_b8268be72c"));
  }
  const result = { files: 0, deferredOwners: { master: 0, masterQQ: 0 } };
  const sourceConfig = join(source, "config");
  const defaultConfig = join(sourceConfig, "default_config");
  const userConfig = join(sourceConfig, "config");
  const hasConfig = await physicalDirectory(sourceConfig);
  const hasDefaults = hasConfig && await physicalDirectory(defaultConfig);
  const hasOverrides = hasConfig && await physicalDirectory(userConfig);
  const deferred: DeferredOwners = { master: [], masterQQ: [] };
  const entries = new Map<ConfigName, Config>();
  for (const key of ["other", "bot"] as const) {
    signal?.throwIfAborted();
    const defaults = hasDefaults ? await readConfig(defaultConfig, key) : undefined;
    const overrides = hasOverrides ? await readConfig(userConfig, key) : undefined;
    const config = defaults === undefined && overrides === undefined ? undefined : projectConfig({ ...defaults, ...overrides }, key, deferred);
    if (key === "bot" && updateNotice) entries.set(key, { ...(config ?? { update_time: 0 }), ...updateNotice, ...config });
    else if (config !== undefined) entries.set(key, config);
  }
  if (!entries.size) return result;
  const parent = await stagingDirectory(target, ["config", "config"]);
  const created: string[] = [];
  async function store(path: string, data: Config) {
    signal?.throwIfAborted();
    const file = await open(path, "wx", 0o600);
    created.push(path);
    try { await file.writeFile(Bun.YAML.stringify(data)); }
    finally { await file.close(); }
  }
  try {
    for (const [name, config] of entries) {
      await store(join(parent, `${name}.yaml`), config);
    }
    if (deferred.master.length || deferred.masterQQ.length) {
      const backup = await stagingDirectory(target, ["backup", "core-config"]);
      if (((await lstat(backup)).mode & 0o077) !== 0) throw new Error($t("lib.migration-core-config.text_f1240a4000"));
      await store(join(backup, "other-provider-owners.yaml"), deferred);
    }
    signal?.throwIfAborted();
    return {
      files: entries.size,
      deferredOwners: { master: deferred.master.length, masterQQ: deferred.masterQQ.length },
    };
  } catch (error) {
    for (const file of created) await unlink(file);
    throw error;
  }
}
