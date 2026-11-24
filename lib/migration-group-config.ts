import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { isNoticeLogLevel, parseNoticeSchedule } from "../plugins/notice/schedule.ts";
import { announcementConfigPaths, parseAnnouncementConfig } from "../plugins/notice/mys-announcement-config.ts";
import { announcementGameKeys } from "../plugins/notice/mys-announcement-source.ts";
import { readScreenedWordList, readScreenedWordSettings, screenedWordLimits } from "../plugins/group/screened-words.ts";
import { groupRoutingScopePattern } from "./group-dispatch.ts";
import { legacyAutoGroupCardScript } from "./plugins/metadata.ts";
import { withinInstallation, type LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";

type Mapping = Map<unknown, unknown>;
const yenai = "plugins/yenai-plugin/config/config/";
const noticeDirectories = ["plugins/Notice-plugin/config/", "plugins/notice-plugin/config/"] as const;
const legacyMysNewsDefaults = "plugins/genshin/defSet/mys/pushNews.yaml";
const legacyGroupDefaults = "config/default_config/group.yaml";
const screenedConfigPaths = ["plugins/flower-plugin/defSet/wordListener.yaml", "plugins/flower-plugin/config/wordListener.yaml", "config/group-screened-words.yaml"] as const;
const screenedLegacyWords = "plugins/flower-plugin/resources/blackword";
const screenedCurrentWords = "data/group/screened-words";
const sourcePaths = [
  "config/auto-group-card.yaml", "config/config/auto-group-card.yaml",
  "config/group-leave-blacklist.yaml", "config/config/group-leave-blacklist.yaml",
  "config/group.yaml", legacyGroupDefaults, `${yenai}thumbUp.yaml`,
  "config/groupAdmin.yaml", `${yenai}groupAdmin.yaml`,
  "config/group-notice.yaml", `${yenai}notice.yaml`, "config/notice.yaml",
  ...screenedConfigPaths,
  ...announcementConfigPaths,
  legacyMysNewsDefaults,
  ...noticeDirectories.flatMap(path => [path + "config_default.yaml", path + "config.yaml"]),
];
const likeFields = ["enable", "cloneAllThumbUp", "strangeThumbUp", "count", "recall", "closeTips", "successMsg", "failsMsg", "noFriendMsg"];
const managementFields = ["whiteQQ", "blackQQ", "noBan", "VoteBan", "VoteKick", "outTime", "minNum", "BanTime", "veto", "voteAdmin"];
const verifyFields = ["openGroup", "mode", "times", "remindAtLastMinute", "time", "DelayTime"];
const noticeFields = ["privateMessage", "grouptemporaryMessage", "groupRecall", "PrivateRecall", "friendRequest", "friendNumberChange",
  "groupMemberNumberChange", "groupAdminChange", "botBeenBanned", "groupNumberChange", "addGroupApplication", "groupInviteRequest",
  "groupMessage", "notificationsAll", "msgSaveDeltime"];
const routingFields = ["groupCD", "singleCD", "onlyReplyAt", "botAlias", "addLimit", "addPrivate", "addReply", "addAt", "addRecall", "enable", "disable"];

interface ConfigSnapshot { readonly info: Stats; readonly bytes: Buffer }

async function named(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function unchanged(first: Stats, next: Stats | undefined) {
  return next && first.dev === next.dev && first.ino === next.ino && first.size === next.size &&
    first.mtimeMs === next.mtimeMs && first.ctimeMs === next.ctimeMs && first.mode === next.mode && first.nlink === next.nlink;
}

function invalid(subject: string) { return new Error(`${subject}配置无法安全迁移。`); }

async function readSnapshot(path: string, signal?: AbortSignal): Promise<ConfigSnapshot | undefined> {
  signal?.throwIfAborted();
  const info = await named(path);
  if (!info) return;
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || await realpath(path) !== path) {
    throw new Error("旧群管和通知配置须为快照内的普通文件。");
  }
  const changed = () => new Error("旧群管和通知配置在迁移期间发生变化，请重新取得停写后的副本。");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!unchanged(info, await handle.stat())) throw changed();
    const bytes = Buffer.alloc(info.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if (!unchanged(info, await handle.stat()) || !unchanged(info, await named(path)) || await realpath(path) !== path) throw changed();
    return { info, bytes };
  } finally { await handle.close(); }
}

function decodedYaml(bytes: Buffer): unknown {
  try {
    const doc = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { merge: true, strict: true, uniqueKeys: true });
    if (!doc.errors.length) return doc.toJS({ mapAsMap: true, maxAliasCount: 50 });
  } catch {}
  throw invalid("旧群管和通知 YAML");
}

function decode(bytes: Buffer): Mapping {
  const parsed = decodedYaml(bytes);
  if (parsed === null || parsed instanceof Map) return parsed ?? new Map();
  throw invalid("旧群管和通知 YAML");
}

function section(value: unknown, name: string) {
  if (value == null) return new Map();
  if (!(value instanceof Map)) throw invalid(name);
  return value;
}

function fields(input: Mapping, supported: readonly string[]) {
  return new Map(supported.filter(key => input.has(key)).map(key => [key, input.get(key)]));
}

function scope(input: unknown, grammar: RegExp) {
  if (typeof input !== "number" && typeof input !== "string") return false;
  const value = String(input);
  return grammar.test(value) && value.split(":").every(part => !/^\d+$/u.test(part) || Number.isSafeInteger(Number(part)));
}

function scopedSettings(input: Mapping, grammar: RegExp, supported: readonly string[], label: string) {
  const selected = new Map();
  const seen = new Set<string>();
  for (const [key, value] of input) {
    if (!scope(key, grammar)) continue;
    if (seen.has(String(key))) throw invalid(label);
    seen.add(String(key));
    selected.set(key, value == null ? value : fields(section(value, label), supported));
  }
  return selected;
}

function mergeManagement(current: Mapping, legacy?: Mapping) {
  const old = legacy ?? new Map();
  const result: Mapping = fields(new Map([...old, ...current]), managementFields);
  // The runtime enables the old vote mute default if it finds a legacy document.
  if (legacy && !result.has("VoteBan")) result.set("VoteBan", true);
  for (const [name, supported] of [["groupAddNotice", ["openGroup", "msg"]], ["groupVerify", verifyFields],
    ["recallMsgPer", ["bot", "member"]]] as const) {
    if (!old.has(name) && !current.has(name)) continue;
    if (name === "recallMsgPer" && ((old.has(name) && old.get(name) == null) || (current.has(name) && current.get(name) == null))) {
      throw invalid("引用撤回权限");
    }
    const previous = section(old.get(name), name);
    const modern = section(current.get(name), name);
    const merged = fields(new Map([...previous, ...modern]), supported);
    if (name === "recallMsgPer" && [...merged.values()].some(value => typeof value !== "string" || !["all", "admin", "owner", "master"].includes(value))) {
      throw invalid("引用撤回权限");
    }
    if (name === "groupVerify") {
      const oldRange = section(previous.get("range"), "入群验证运算范围");
      const range = section(modern.get("range"), "入群验证运算范围");
      const limits = new Map(["min", "max"].flatMap(field => {
        const value = range.get(field) ?? oldRange.get(field);
        return value === undefined ? [] : [[field, value] as const];
      }));
      if (limits.size) merged.set("range", limits);
      const oldMessages = section(previous.get("SuccessMsgs"), "入群验证成功消息");
      const messages = section(modern.get("SuccessMsgs"), "入群验证成功消息");
      const ids = new Set([...oldMessages.keys(), ...messages.keys()].filter(key => scope(key, /^(?:0|[1-9]\d*)$/u)).map(String));
      if (ids.size) merged.set("SuccessMsgs", new Map([...ids].map(key => [key,
        messages.get(Number(key)) ?? messages.get(key) ?? oldMessages.get(Number(key)) ?? oldMessages.get(key),
      ])));
    }
    result.set(name, merged);
  }
  return result;
}

function scheduleSettings(load: (path: string) => Mapping | undefined) {
  const supported = ["enableSchedule", "scheduleTime", "logger"];
  const logLevel = (config: Mapping) => {
    const value = config.get("logger");
    return isNoticeLogLevel(value) ? value : "info";
  };
  let selected = load("config/notice.yaml");
  if (!selected) {
    let expected: ReturnType<typeof parseNoticeSchedule>;
    for (const directory of noticeDirectories) {
      const defaults = load(directory + "config_default.yaml"), custom = load(directory + "config.yaml");
      if (!defaults && !custom) continue;
      const candidate = fields(new Map([...defaults ?? [], ...custom ?? []]), supported);
      const parsed = parseNoticeSchedule(stringify(candidate));
      if (selected && (parsed?.start !== expected?.start || parsed?.end !== expected?.end)) {
        throw new Error("两处旧公告定时窗口不一致，请先核对使用的公告配置。");
      }
      if (selected && logLevel(selected) !== logLevel(candidate)) throw new Error("两处旧公告日志级别不一致，请先核对配置。");
      selected = candidate;
      expected = parsed;
    }
  }
  if (!selected) return;
  const result = fields(selected, supported);
  parseNoticeSchedule(stringify(result));
  return result;
}

function mysAnnouncementSettings(load: (path: string) => Mapping | undefined) {
  const current = load(announcementConfigPaths[0]) ?? load(announcementConfigPaths[1]);
  if (current) {
    parseAnnouncementConfig(stringify(current));
    return current;
  }
  const defaults = load(legacyMysNewsDefaults);
  const legacy = load(announcementConfigPaths[2]);
  if (!defaults && !legacy) return;
  const settings = new Map([...defaults ?? [], ...legacy ?? []]);
  if (settings.has("banWord")) {
    const words = new Map(section(settings.get("banWord"), "米游社标题过滤"));
    // An explicit old banWord mapping replaced the entire default mapping.
    for (const game of announcementGameKeys) if (!words.has(game)) words.set(game, "");
    settings.set("banWord", words);
  }
  parseAnnouncementConfig(stringify(settings));
  return settings;
}

function project(load: (path: string) => Mapping | undefined) {
  const active = new Map<string, Mapping>();
  for (const [name, supported] of [
    ["auto-group-card", ["enable", "cron", "nickname", "notGroup", "suffixes"]],
    ["group-leave-blacklist", ["enable", "groups"]],
  ] as const) {
    const path = `config/${name}.yaml`;
    const source = load(path) ?? load(`config/config/${name}.yaml`);
    if (source) active.set(path, fields(source, supported));
  }

  const modernGroup = load("config/group.yaml");
  const oldLikes = load(`${yenai}thumbUp.yaml`);
  const routing = scopedSettings(modernGroup ?? new Map(), groupRoutingScopePattern, routingFields, "群派发");
  if (modernGroup || oldLikes) {
    const likes = fields(new Map([...oldLikes ?? [], ...modernGroup ?? []]), likeFields);
    if (oldLikes && !likes.has("recall")) likes.set("recall", 20);
    active.set("config/group.yaml", new Map([...routing, ...likes]));
  }
  if (!routing.size) {
    const defaults = load(legacyGroupDefaults);
    if (defaults) active.set(legacyGroupDefaults, scopedSettings(defaults, groupRoutingScopePattern, routingFields, "旧群派发默认值"));
  }
  const oldManagement = load(`${yenai}groupAdmin.yaml`);
  const modernManagement = load("config/groupAdmin.yaml");
  if (oldManagement || modernManagement) active.set("config/groupAdmin.yaml", mergeManagement(modernManagement ?? new Map(), oldManagement));
  const notices = load("config/group-notice.yaml") ?? load(`${yenai}notice.yaml`);
  if (notices) active.set("config/group-notice.yaml", scopedSettings(notices,
    /^(?:default|[1-9]\d*|bot:[1-9]\d*(?::[1-9]\d*)?)$/u, noticeFields, "群通知"));
  const schedule = scheduleSettings(load);
  if (schedule) active.set("config/notice.yaml", schedule);
  const community = mysAnnouncementSettings(load);
  if (community) active.set(announcementConfigPaths[0], community);
  return active;
}

async function screenedWordSources(source: string) {
  async function entries(relative: string) {
    const path = join(source, relative);
    const info = await named(path);
    if (!info) return [];
    if (!info.isDirectory() || await realpath(path) !== path) throw invalid("旧屏蔽词目录");
    return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  }
  const validScope = (value: string) => value === "global" || /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
  const modern = new Map((await entries(screenedCurrentWords)).flatMap(entry => {
    const name = entry.name.endsWith(".yaml") ? entry.name.slice(0, -5) : "";
    return entry.isFile() && validScope(name) ? [[name, join(screenedCurrentWords, entry.name)] as const] : [];
  }));
  const legacy = new Map<string, string[]>();
  for (const entry of await entries(screenedLegacyWords)) {
    if (!entry.isDirectory() || !validScope(entry.name)) continue;
    const folder = join(screenedLegacyWords, entry.name);
    const files = (await entries(folder)).filter(file => file.isFile() && file.name.endsWith(".yaml"));
    if (files.length > screenedWordLimits.files) throw invalid("屏蔽词词表数量");
    if (files.length) legacy.set(entry.name, files.reverse().map(file => join(folder, file.name)));
  }
  return [...new Set([...modern.keys(), ...legacy.keys()])].map(scope => ({ scope, modern: modern.get(scope), legacy: legacy.get(scope) ?? [] }));
}

function projectScreenedWords(load: (path: string) => Mapping | undefined, scopes: Awaited<ReturnType<typeof screenedWordSources>>,
  snapshots: ReadonlyMap<string, ConfigSnapshot>) {
  const files = new Map<string, string>();
  const settings = screenedConfigPaths.map(path => load(path));
  if (settings.some(Boolean)) {
    const combined = new Map(settings.flatMap(value => [...value ?? []]));
    const supported = Object.fromEntries(fields(combined, ["enable", "time", "replyText"]));
    files.set(screenedConfigPaths[2], stringify(readScreenedWordSettings(supported)));
  }
  for (const scope of scopes) {
    const paths = scope.modern ? [scope.modern] : scope.legacy;
    const words = new Set<string>();
    let size = 0;
    for (const path of paths) {
      const bytes = snapshots.get(path)!.bytes;
      size += bytes.length;
      if (size > screenedWordLimits.bytes) throw invalid("屏蔽词词表大小");
      for (const text of readScreenedWordList(decodedYaml(bytes), !scope.modern)) words.add(text);
      if (words.size > screenedWordLimits.words) throw invalid("屏蔽词数量");
    }
    const content = stringify([...words]);
    if (Buffer.byteLength(content) > screenedWordLimits.bytes) throw invalid("屏蔽词词表大小");
    files.set(join(screenedCurrentWords, scope.scope + ".yaml"), content);
  }
  return files;
}

/** Stage runtime configurations after rejected legacy plugins leave the plugin tree. Keep source YAML in a private rollback copy. */
export async function stageLegacyGroupConfig(sourcePath: string, stateDirectory: string, signal?: AbortSignal,
  legacyPlugins: readonly LegacyPluginPlanEntry[] = []) {
  signal?.throwIfAborted();
  const [source, stage] = await Promise.all([realpath(sourcePath), realpath(stateDirectory)]);
  const stageInfo = await lstat(stage);
  if (withinInstallation(source, stage) || withinInstallation(stage, source) || !(await lstat(source)).isDirectory() ||
      stage !== resolve(stateDirectory) || !stageInfo.isDirectory() || (stageInfo.mode & 0o077)) {
    throw new Error("群管和通知配置须暂存到独立私有实体目录。");
  }
  const inputs = new Map<string, ConfigSnapshot>();
  const screenedScopes = await screenedWordSources(source);
  const screenedInputs = new Set(screenedScopes.flatMap(scope => [...scope.legacy, ...(scope.modern ? [scope.modern] : [])]));
  for (const path of [...sourcePaths, ...screenedInputs]) {
    const result = await readSnapshot(join(source, path), signal);
    if (result) inputs.set(path, result);
    else if (screenedInputs.has(path)) throw invalid("并发变动的屏蔽词");
  }
  const decoded = new Map<string, Mapping>();
  const load = (path: string) => {
    const prior = decoded.get(path);
    if (prior) return prior;
    const item = inputs.get(path);
    if (!item) return;
    const settings = decode(item.bytes);
    decoded.set(path, settings);
    return settings;
  };
  const active = project(load);
  const cardConfig = "config/auto-group-card.yaml";
  if (!active.has(cardConfig) && legacyPlugins.some(entry => entry.status === "archive" && entry.kind === "script" &&
      entry.path === legacyAutoGroupCardScript.path && entry.identity === legacyAutoGroupCardScript.identity)) {
    active.set(cardConfig, new Map([["enable", true]]));
  }
  // Legacy files omitted enable because the old script defaulted to enabled.
  const migratedCard = active.get(cardConfig);
  if (migratedCard && !migratedCard.has("enable")) migratedCard.set("enable", true);
  const screened = projectScreenedWords(load, screenedScopes, inputs);
  const archives = new Map([...inputs].map(([path, config]) => [join("backup", "legacy-group-config", path), config.bytes]));
  const files = [...[...active].map(([path, settings]) => [path, stringify(settings)] as const), ...screened, ...archives];
  if (JSON.stringify(screenedScopes) !== JSON.stringify(await screenedWordSources(source))) throw invalid("并发变动的屏蔽词目录");
  for (const [path, config] of inputs) {
    const absolute = join(source, path);
    if (!unchanged(config.info, await named(absolute)) || await realpath(absolute) !== absolute) throw invalid("并发变动的旧群管和通知");
  }
  async function ensureDirectory(path: string) {
    if (path === stage) return;
    await ensureDirectory(dirname(path));
    if (!await named(path)) await mkdir(path, { mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || (info.mode & 0o077) || await realpath(path) !== path) throw invalid("群管和通知暂存目录");
  }
  for (const [path, bytes] of files) {
    signal?.throwIfAborted();
    const destination = join(stage, path);
    await ensureDirectory(dirname(destination));
    await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  }
  const scopes = noticeDirectories.flatMap(directory => [directory + "config_default.yaml", directory + "config.yaml"]).flatMap(path => {
    try { return load(path) ?? []; } catch { return []; }
  });
  const deferred = ["multiAccount", "pushSettings"].filter(key => scopes.some(config => config.has(key))).map(key => `notice.${key}`);
  return { active: [...active.keys(), ...screened.keys()], archived: [...archives.keys()], deferred };
}
