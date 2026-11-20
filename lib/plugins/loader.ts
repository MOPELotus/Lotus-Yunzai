import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { GroupTransport } from "../adapters/onebot-groups.ts";
import type { TimedGroupMuteBinding, TimedGroupMuteResult } from "../adapters/group-moderation.ts";
import type { OwnGroupCardAccount } from "../adapters/own-group-card.ts";
import type { ProfileLikeImage } from "../adapters/mention-like.ts";
import type { GroupBannedWords } from "../../plugins/group/banned-words.ts";
import type { FriendMessageNotice, FriendPokeNotice, FriendRecallNotice, FriendRelationshipNotice, FriendRequestNotice, GroupAddNotice, GroupRecallNotice, GroupVerification,
  TemporaryMessageNotice } from "../../plugins/group/index.ts";
import type { GroupLeaveBlacklist, GroupLeaveBlacklistIO } from "../../plugins/group/group-leave-blacklist.ts";
import type { GroupMessageNotice } from "../../plugins/group/group-message-notice.ts";
import type { GroupOwnerAdminNotice } from "../../plugins/group/group-owner-admin-notice.ts";
import type { GroupOwnerBanNotice } from "../../plugins/group/group-owner-ban-notice.ts";
import type { GroupOwnerGroupNotice } from "../../plugins/group/group-owner-group-notice.ts";
import type { GroupOwnerInvitationNotice } from "../../plugins/group/group-owner-invitation-notice.ts";
import type { GroupOwnerJoinRequestNotice } from "../../plugins/group/group-owner-join-request-notice.ts";
import type { GroupOwnerMemberNotice } from "../../plugins/group/group-owner-member-notice.ts";
import type { OwnerNoticeRecipients } from "../../plugins/group/owner-notice-recipients.ts";
import type { CalendarSchedule, CalendarScheduleOptions } from "../../plugins/guides/calendar-schedule.ts";
import type { BotNotifications } from "../checkin-notify.ts";
import type { ExecuteService } from "../../plugins/execute/index.ts";
import { builtInDirectories, systemModuleName } from "../builtin-modules.ts";
import type { CommandContext, CommandModule, CommandRegistry } from "../commands.ts";
import type { FileToUrl } from "../file-to-url.ts";
import type { GachaGame, GachaUpdater } from "../gacha-batch.ts";
import type { lockFile } from "../file-lock.ts";
import { isManagedPluginDirectory, managedUpdateDirectoryLimit } from "../managed-update-protocol.ts";
import { defaultPluginLoadMs } from "../plugin-load-progress.ts";
import type { RuntimeVersion } from "../runtime-version.ts";
import { watchLegacyFiles } from "./file-watch.ts";
import type { LegacyPlugins } from "./legacy.ts";
import { inspectPluginMetadata, pluginScriptExtensions, retiredPluginScript } from "./metadata.ts";

interface Candidate {
  readonly path: string;
  readonly kind: "package" | "script";
}

export { systemModuleName };

const gachaGames: ReadonlyMap<string, GachaGame> = new Map([
  ["@lotus-yunzai/genshin", "gs"], ["@lotus-yunzai/starrail", "sr"], ["@lotus-yunzai/zzz", "zzz"],
]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isMissing(error: unknown): boolean {
  return record(error).code === "ENOENT";
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function entriesAt(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function listCandidates(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const entry of await entriesAt(root)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      candidates.push({ path, kind: "package" });
    } else if (entry.isFile() && extname(entry.name) === ".js") {
      candidates.push({ path, kind: "script" });
    }
  }
  const builtInPaths = new Set([...builtInDirectories.values()].map((directory) => join(root, directory)));
  return candidates.sort((left, right) =>
    Number(builtInPaths.has(right.path)) - Number(builtInPaths.has(left.path)) ||
    left.path.localeCompare(right.path, "en"));
}

function flatScript(name: string): boolean {
  return !name.startsWith(".") && name.endsWith(".js") && name !== "guoba.support.js";
}

async function legacyEntries(directory: string) {
  const entries = await entriesAt(directory);
  if (entries.some((entry) => entry.name === "index.js")) return { scripts: ["index.js"], flat: new Set<string>() };

  const flat = new Set(entries.filter((entry) => entry.isFile() && flatScript(entry.name)).map((entry) => entry.name));
  const scripts = [...flat];
  for (const entry of await entriesAt(join(directory, "apps"))) {
    if (entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".js")) {
      scripts.push(join("apps", entry.name));
    }
  }
  return { scripts: scripts.sort(), flat };
}

function scriptHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readFlatScript(path: string): Promise<Buffer | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).isFile()) return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isMissing(error) && record(error).code !== "ELOOP") throw error;
  }
}

async function gitRepositories(directory: string): Promise<string[]> {
  try {
    await stat(join(directory, ".git"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const git = Bun.which("git");
  if (!git) {
    throw new Error("发现 Git 插件，请安装 Git 以检查仓库来源。");
  }
  const process = Bun.spawn([git, "config", "--local", "--no-includes", "--get-regexp", "^remote\\..*\\.url$"], {
    cwd: directory, stdout: "pipe", stderr: "ignore",
  });
  const output = await new Response(process.stdout).text();
  const exit = await process.exited;
  if (exit === 1) return [];
  if (exit !== 0) throw new Error("无法读取插件的 Git 仓库来源。");
  return output.trim().split("\n").map((line) => line.slice(line.indexOf(" ") + 1));
}

async function findEntry(directory: string, value: string): Promise<string> {
  if (isAbsolute(value)) {
    throw new Error("插件入口须使用包内相对路径。");
  }
  const root = await realpath(directory);
  const path = await realpath(resolve(root, value));
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ||
      !pluginScriptExtensions.has(extname(path)) || !(await stat(path)).isFile()) {
    throw new Error("插件入口须是包内的 JS 或 TS 文件。");
  }
  return path;
}

interface StatusStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

interface PluginServices {
  readonly groups: GroupTransport;
  readonly subscriptionTransport?: () => readonly BotNotifications[];
  readonly execute?: ExecuteService;
  readonly fileToUrl: FileToUrl;
  readonly lockFile: typeof lockFile;
  readonly signal: AbortSignal;
  readonly messageStatistics: (argument: string, context: CommandContext) => Promise<string>;
  readonly runtimeVersion: RuntimeVersion;
  readonly runtimeStatus?: ReturnType<typeof import("../runtime-status.ts").createRuntimeStatus>;
  readonly statusPhotoStorage?: StatusStorage;
  readonly statusMonitorStorage?: StatusStorage;
  readonly runtimeDiagnostics: (context: CommandContext) => {
    readonly accounts: readonly { readonly id: number; readonly seconds: number; readonly adapter?: "milky" }[];
    readonly plugins: readonly PluginLoadTiming[];
  } | undefined;
}

export interface PluginLoadTiming {
  readonly name: string;
  readonly milliseconds: number;
}

export interface PluginLoadRecord {
  readonly name: string;
  readonly status: "loaded" | "rejected" | "failed" | "skipped";
  readonly reason?: string;
}

export interface PluginLoadReport {
  readonly records: readonly PluginLoadRecord[];
  readonly directories: ReadonlyMap<string, { path: string; packageName: string }>;
  readonly readyDirectories: readonly string[];
  readonly timings: readonly PluginLoadTiming[];
  startWatching(): void;
  dispose(): Promise<void>;
}

interface AtlasScheduledRun {
  readonly cron?: string;
  readonly issue?: string;
  run(): Promise<string>;
}

type AtlasSchedule = Readonly<Partial<Record<"version" | "challenge", AtlasScheduledRun>>>;

async function disposeModule(name: string, cleanup: () => unknown): Promise<void> {
  try {
    await cleanup();
  } catch {
    console.warn(`[插件] 清理 ${name} 失败。`);
  }
}

export async function loadPlugins(
  root: string,
  commands: CommandRegistry,
  legacy: LegacyPlugins,
  services: PluginServices,
  options: {
    readonly loadTimeout?: number;
    readonly reportLoading?: (wait: number) => void;
    readonly fileWatch?: boolean;
    readonly registerGacha?: (game: GachaGame, update: GachaUpdater) => () => void;
    readonly hostReplacementModules?: readonly string[];
    readonly groupServices?: {
      ownGroupCardAccounts(): readonly OwnGroupCardAccount[];
      registerAutoGroupCardTask(cron: string, run: () => Promise<unknown>): () => Promise<void>;
      groupTimedMute?: {
        readLegacy(): Promise<string | null>;
        validateCron(cron: string): boolean;
        register(name: string, cron: string, run: () => Promise<void>): () => void | Promise<void>;
        execute(binding: TimedGroupMuteBinding, signal: AbortSignal): Promise<TimedGroupMuteResult>;
        report?(binding: TimedGroupMuteBinding, result: TimedGroupMuteResult): void;
      };
      autoRepeatSessionSignal(event: unknown): AbortSignal | undefined;
      readAutoRepeatImage(url: unknown, signal?: AbortSignal): Promise<Uint8Array | undefined>;
      readonly profileLikeImage?: ProfileLikeImage;
      readonly noticeSettingsThemeDirectory?: string;
      registerManagedBlacklist?(policy: {
        blocked(userId: number): Promise<boolean>;
        shouldAutoUnmute(userId: number): Promise<boolean>;
      }): () => void;
      registerGroupBannedWords?(policy: GroupBannedWords): () => void;
      registerGroupAddNotice?(policy: GroupAddNotice): () => void;
      registerFriendRequestNotice?(policy: FriendRequestNotice): () => void;
      registerFriendMessageNotice?(policy: FriendMessageNotice): () => void;
      registerTemporaryMessageNotice?(policy: TemporaryMessageNotice): () => void;
      registerFriendRelationshipNotice?(policy: FriendRelationshipNotice): () => void;
      registerFriendPokeNotice?(policy: FriendPokeNotice): () => void;
      registerFriendRecallNotice?(policy: FriendRecallNotice): () => void;
      registerGroupRecallNotice?(policy: GroupRecallNotice): () => void;
      registerGroupMessageNotice?(policy: GroupMessageNotice): () => void;
      registerGroupOwnerMemberNotice?(policy: GroupOwnerMemberNotice): () => void;
      registerGroupOwnerAdminNotice?(policy: GroupOwnerAdminNotice): () => void;
      registerGroupOwnerBanNotice?(policy: GroupOwnerBanNotice): () => void;
      registerGroupOwnerGroupNotice?(policy: GroupOwnerGroupNotice): () => void;
      registerGroupOwnerJoinRequestNotice?(policy: GroupOwnerJoinRequestNotice): () => void;
      registerGroupOwnerInvitationNotice?(policy: GroupOwnerInvitationNotice): () => void;
      registerOwnerNoticeRecipients?(policy: OwnerNoticeRecipients): () => void;
      registerGroupVerification?(policy: GroupVerification): () => void;
      readonly groupLeaveBlacklist: {
        readonly io: GroupLeaveBlacklistIO;
        register(policy: GroupLeaveBlacklist): () => void;
      };
    };
    readonly profileLikeImages?: {
      readonly directory: string;
      register(renderer: ProfileLikeImage): () => void;
    };
    readonly guidesSchedule?: {
      register(policy: CalendarSchedule): () => void;
      registerTask: CalendarScheduleOptions["register"];
      targets: CalendarScheduleOptions["targets"];
      whenReady(start: () => void): () => void;
    };
    readonly atlasUpdate?: {
      readonly config: unknown;
      register(schedule: AtlasSchedule): () => Promise<void>;
    };
  } = {},
): Promise<PluginLoadReport> {
  const records: PluginLoadRecord[] = [];
  const timings: PluginLoadTiming[] = [];
  const directories = new Map<string, { path: string; packageName: string }>();
  const retiredDirectories = new Map<string, ReadonlySet<string>>();
  const hostReplacements = new Set(options.hostReplacementModules?.filter(name => commands.hasModule(name)));
  const loadedEntries = new Map<string, { path: string; packageName: string }>();
  const watched = new Map<string, {
    packageName: string;
    physicalPath: string;
    identities: ReadonlySet<string>;
    attempted: Map<string, string>;
    active: Map<string, string>;
  }>();
  const cleanups: { name: string; cleanup: () => unknown }[] = [];
  const interruptedCleanups: Promise<void>[] = [];
  const seen = new Map<string, string>();
  const ready: { label: string; entry: string; moduleName?: string; directory?: string; packageName?: string }[] = [];
  const reject = (name: string, reason: string, label = name) => {
    console.warn(`[插件] 拒绝加载 ${label}：${reason}`);
    records.push({ name, status: "rejected", reason });
  };
  const rejectRetiredScript = (path: string, bytes: Uint8Array) => {
    const retired = retiredPluginScript(bytes);
    if (!retired) return;
    const name = relative(root, path);
    reject(name, retired.reason, `${name}（${retired.name}）`);
    return retired;
  };
  for (const candidate of await listCandidates(root)) {
    if (services.signal.aborted) break;
    const label = relative(root, candidate.path);
    try {
      if (candidate.kind === "script") {
        if (!rejectRetiredScript(candidate.path, await readFile(candidate.path))) {
          ready.push({ label, entry: candidate.path });
        }
        continue;
      }

      const directory = basename(candidate.path);
      const source = await readOptional(join(candidate.path, "package.json"));
      const { name, identities, entry: declaredEntry, rejection, rejectionIdentity } = inspectPluginMetadata(
        directory, source, await gitRepositories(candidate.path),
      );
      if (rejection) {
        reject(label, rejection, rejectionIdentity ? `${label}（${rejectionIdentity}）` : label);
        continue;
      }
      if (commands.hasModule(name)) {
        reject(label, `模块 ${name} 已注册。`);
        continue;
      }
      const duplicate = identities.map((identity) => seen.get(identity)).find((path) => path !== undefined);
      if (duplicate) {
        reject(label, `与 ${duplicate} 重复。`);
        continue;
      }
      if (declaredEntry !== undefined) {
        const entry = await findEntry(candidate.path, declaredEntry);
        const retired = rejectRetiredScript(entry, await readFile(entry));
        if (retired) {
          retiredDirectories.set(directory, new Set([retired.module]));
          continue;
        }
        ready.push({ label, entry, moduleName: name, directory: candidate.path, packageName: name });
      } else {
        const entries = [];
        const { scripts, flat } = await legacyEntries(candidate.path);
        const attempted = new Map<string, string>();
        const retiredModules = new Set<string>();
        for (const file of scripts) {
          const entry = await findEntry(candidate.path, file);
          const bytes = await readFile(entry);
          if (options.fileWatch && flat.has(file)) attempted.set(file, scriptHash(bytes));
          const retired = rejectRetiredScript(entry, bytes);
          if (retired) retiredModules.add(retired.module);
          else {
            entries.push({ label: relative(root, join(candidate.path, file)), entry, directory: candidate.path, packageName: name });
          }
        }
        if (!entries.length) {
          if (retiredModules.size) retiredDirectories.set(directory, retiredModules);
          continue;
        }
        ready.push(...entries);
        if (attempted.size) watched.set(candidate.path, {
          packageName: name, physicalPath: await realpath(candidate.path),
          identities: new Set(identities), attempted, active: new Map(),
        });
      }
      for (const identity of identities) seen.set(identity, label);
    } catch {
      reject(label, "无法读取插件元数据，或入口路径无效。");
    }
  }

  const loadTimeout = options.loadTimeout ?? defaultPluginLoadMs;
  function recordLoaded(label: string, started: number, path?: string, packageName?: string) {
    records.push({ name: label, status: "loaded" });
    timings.push({ name: label, milliseconds: performance.now() - started });
    if (path && packageName) {
      const metadata = { path, packageName };
      loadedEntries.set(label, metadata);
      directories.set(basename(path), metadata);
    }
  }

  function clearEntry(label: string) {
    const metadata = loadedEntries.get(label);
    loadedEntries.delete(label);
    if (metadata && ![...loadedEntries.values()].some(({ path }) => path === metadata.path)) {
      directories.delete(basename(metadata.path));
    }
    for (let index = records.length - 1; index >= 0; index--) {
      if (records[index]?.name === label) records.splice(index, 1);
    }
    const timing = timings.findIndex(({ name }) => name === label);
    if (timing !== -1) timings.splice(timing, 1);
  }

  for (const { label, entry, moduleName, directory, packageName } of ready) {
    if (services.signal.aborted) break;
    const deadline = new AbortController();
    const signal = AbortSignal.any([services.signal, deadline.signal]);
    options.reportLoading?.(loadTimeout);
    const timer = setTimeout(() => deadline.abort(), loadTimeout);
    const started = performance.now();
    let cleanup: (() => unknown) | undefined;
    let unregister: (() => void) | undefined;
    const cancel = () => {
      unregister?.();
      unregister = undefined;
    };
    const disposeEntry = async () => {
      const dispose = cleanup;
      cleanup = undefined;
      if (dispose) await disposeModule(label, dispose);
    };
    const interrupted = Promise.withResolvers<never>();
    const cancellation = addAbortListener(signal, () => {
      cancel();
      if (cleanup) interruptedCleanups.push(disposeEntry());
      interrupted.reject(signal.reason);
    });
    const loading = (async () => {
      const published = await import(pathToFileURL(entry).href);
      signal.throwIfAborted();
      if (moduleName) {
        const create = published.createModule;
        if (create !== undefined && typeof create !== "function") {
          throw new Error("createModule 须为模块工厂函数。");
        }
        const builtIn = directory && relative(root, directory) === builtInDirectories.get(moduleName);
        const group = builtIn && moduleName === "@lotus-yunzai/group" ? options.groupServices : undefined;
        const atlasUpdate = builtIn && moduleName === "@lotus-yunzai/atlas" ? options.atlasUpdate : undefined;
        const guidesSchedule = builtIn && moduleName === "@lotus-yunzai/guides" ? options.guidesSchedule : undefined;
        const module = create ? await create(Object.freeze({ ...services, ...group, signal,
          ...(atlasUpdate && { atlasUpdateConfig: atlasUpdate.config }),
          ...(guidesSchedule && { guidesSchedule }),
        })) : published.default;
        const { commands: handlers, aliases, fallback, fallbackFeatures, dispose, gachaUpdate, atlasSchedule } = record(module);
        if (dispose !== undefined) {
          if (typeof dispose !== "function") throw new Error("dispose 须为模块清理函数。");
          cleanup = () => dispose.call(module);
        }
        signal.throwIfAborted();
        if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
          throw new Error("入口必须通过默认导出提供 commands。");
        }
        if (aliases !== undefined && (aliases === null || typeof aliases !== "object" || Array.isArray(aliases))) {
          throw new Error("aliases 须为指令别名与本模块指令名的映射。");
        }
        if (fallbackFeatures !== undefined && typeof fallbackFeatures !== "function") {
          throw new Error("fallbackFeatures 须为按指令返回功能名称的函数。");
        }
        unregister = commands.registerModule({
          name: moduleName, commands: handlers as CommandModule["commands"], aliases: aliases as CommandModule["aliases"],
          fallback: fallback as CommandModule["fallback"],
          fallbackFeatures: fallbackFeatures as CommandModule["fallbackFeatures"],
        }, label);
        if (builtIn && moduleName === "@lotus-yunzai/meme" && options.profileLikeImages &&
            typeof published.createProfileLikeImageRenderer === "function") {
          const renderer = published.createProfileLikeImageRenderer(options.profileLikeImages.directory);
          if (typeof renderer !== "function") throw new Error("资料卡回执图片入口必须返回渲染函数。");
          const removeRenderer = options.profileLikeImages.register(renderer);
          const dispose = cleanup;
          cleanup = async () => {
            removeRenderer();
            await dispose?.();
          };
        }
        const game = gachaGames.get(moduleName);
        if (game && directory && relative(root, directory) === builtInDirectories.get(moduleName) &&
            gachaUpdate !== undefined && options.registerGacha) {
          if (typeof gachaUpdate !== "function") throw new Error("gachaUpdate 须为抽卡记录更新函数。");
          const unregisterGacha = options.registerGacha(game, gachaUpdate as GachaUpdater);
          const disposeFactory = cleanup;
          cleanup = () => {
            unregisterGacha();
            return disposeFactory?.();
          };
        }
        if (atlasUpdate && atlasSchedule) {
          const stopSchedule = atlasUpdate.register(atlasSchedule as AtlasSchedule);
          const disposeFactory = cleanup;
          cleanup = async () => {
            await stopSchedule();
            await disposeFactory?.();
          };
        }
        if (published.apps !== undefined) {
          if (published.apps === null || typeof published.apps !== "object") {
            throw new Error("apps 须导出 V3 插件类。");
          }
          await legacy.register(published, label, packageName, signal, directory);
        }
        return "loaded" as const;
      }
      return legacy.register(published, label, packageName, signal, directory);
    })().catch(async (error: unknown) => {
      cancel();
      await disposeEntry();
      throw error;
    });
    try {
      const result = await Promise.race([loading, interrupted.promise]);
      signal.throwIfAborted();
      if (result !== "loaded") {
        const reason = result === "skipped" ? "插件初始化请求跳过。" : "未导出可用的 V3 插件类。";
        console.warn(`[插件] 跳过 ${label}：${reason}`);
        records.push({ name: label, status: "skipped", reason });
        continue;
      }
      console.log(`[插件] 已加载 ${label}。`);
      recordLoaded(label, started, directory, packageName);
      const watch = directory && watched.get(directory);
      const fingerprint = watch && watch.attempted.get(basename(entry));
      if (watch && fingerprint && entry === join(watch.physicalPath, basename(entry))) {
        watch.active.set(basename(entry), fingerprint);
      }
      if (cleanup) cleanups.push({ name: label, cleanup });
    } catch (error) {
      if (services.signal.aborted) break;
      if (deadline.signal.aborted) {
        console.warn(`[插件] ${label} 加载超时。`);
        records.push({ name: label, status: "failed", reason: "插件加载超时。" });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[插件] 加载 ${label} 失败：${message}`);
      records.push({ name: label, status: "failed", reason: "入口加载或初始化失败，请查看宿主日志。" });
    } finally {
      clearTimeout(timer);
      cancellation[Symbol.dispose]();
    }
  }
  if (!services.signal.aborted) options.reportLoading?.(0);

  async function reconcile(directory: string, signal: AbortSignal) {
    const watch = watched.get(directory);
    if (!watch || signal.aborted) return;
    const info = await lstat(directory).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    const physical = info?.isDirectory() && await realpath(directory) === watch.physicalPath;
    const entries = physical ? await entriesAt(directory) : [];
    const files = new Set(entries.filter(({ name }) => flatScript(name)).map(({ name }) => name));
    for (const file of watch.attempted.keys()) {
      if (signal.aborted) return;
      if (files.has(file)) continue;
      const label = relative(root, join(directory, file));
      await legacy.remove(label);
      watch.attempted.delete(file);
      if (watch.active.delete(file)) console.log(`[插件] 已卸载 ${label}。`);
      clearEntry(label);
    }
    if (!physical || entries.some(({ name }) => name === "index.js")) return;

    const stillApproved = async () => {
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== watch.physicalPath ||
          (await entriesAt(directory)).some(({ name }) => name === "index.js")) return false;
      const metadata = inspectPluginMetadata(basename(directory), await readOptional(join(directory, "package.json")),
        await gitRepositories(directory));
      const identities = new Set(metadata.identities);
      return !metadata.rejection && metadata.entry === undefined && metadata.name === watch.packageName &&
        identities.size === watch.identities.size && metadata.identities.every((id) => watch.identities.has(id));
    };
    if (!await stillApproved()) return;

    for (const file of [...files].sort()) {
      if (signal.aborted) return;
      const entry = join(directory, file);
      const bytes = await readFlatScript(entry);
      if (!bytes) continue;
      const hash = scriptHash(bytes);
      if (watch.attempted.get(file) === hash) continue;
      watch.attempted.set(file, hash);
      if (watch.active.get(file) === hash) continue;
      const label = relative(root, entry);
      const retired = retiredPluginScript(bytes);
      if (retired) {
        console.warn(`[插件] 拒绝热更新 ${label}（${retired.name}）：${retired.reason}`);
        continue;
      }
      if (entry.includes("?")) {
        console.warn(`[插件] 热更新 ${label} 失败：Bun 无法区分入口路径中的问号和导入参数。`);
        continue;
      }
      const deadline = new AbortController();
      const loading = AbortSignal.any([signal, deadline.signal]);
      const timer = setTimeout(() => deadline.abort(), loadTimeout);
      const start = performance.now();
      const aborted = Promise.withResolvers<never>();
      const cancel = addAbortListener(loading, () => aborted.reject(loading.reason));
      const unchanged = async () => {
        if (!await stillApproved()) return false;
        const latest = await readFlatScript(entry);
        return latest !== undefined && scriptHash(latest) === hash;
      };
      const replacement = (async () => {
        if (!await unchanged() || loading.aborted) return;
        // Bun keeps the query for absolute paths. Converting to file: would reuse the old module.
        const published = await import(`${entry}?lotus-reload=${crypto.randomUUID()}`);
        loading.throwIfAborted();
        const result = await legacy.replace(published, label, watch.packageName, loading, unchanged, directory);
        if (result === "loaded") {
          clearEntry(label);
          recordLoaded(label, start, directory, watch.packageName);
          watch.active.set(file, hash);
          console.log(`[插件] 已热更新 ${label}。`);
        } else if (!loading.aborted) {
          console.warn(`[插件] 热更新 ${label} 失败：入口没有可启用的 V3 插件。`);
        }
      })();
      try {
        await Promise.race([replacement, aborted.promise]);
      } catch (error) {
        if (!signal.aborted) {
          const message = deadline.signal.aborted ? "加载超时。" : (error instanceof Error ? error.message : String(error));
          console.warn(`[插件] 热更新 ${label} 失败：${message}`);
        }
      } finally {
        cancel[Symbol.dispose]();
        clearTimeout(timer);
      }
    }
  }

  let watcher: ReturnType<typeof watchLegacyFiles> | undefined;
  let disposal: Promise<void> | undefined;
  const readyDirectories = new Set(directories.keys());
  for (const [directory, replacements] of retiredDirectories) {
    if (readyDirectories.size >= managedUpdateDirectoryLimit) break;
    if (!isManagedPluginDirectory(directory)) continue;
    // Older supervisors still require the original directory name during activation.
    if ([...replacements].every(module => {
      if (hostReplacements.has(module)) return true;
      const builtIn = builtInDirectories.get(module);
      return builtIn !== undefined && directories.get(builtIn)?.packageName === module;
    })) readyDirectories.add(directory);
  }
  return {
    records, directories, timings, readyDirectories: [...readyDirectories],
    startWatching() {
      if (!watcher && watched.size && !services.signal.aborted && !disposal) {
        watcher = watchLegacyFiles(root, [...watched.keys()], reconcile, {
          signal: services.signal,
          relevantFile: (name) => name === "package.json" || name === ".git" || flatScript(name),
        });
      }
    },
    dispose() {
      return disposal ??= (async () => {
        await watcher?.stop();
        await Promise.all(interruptedCleanups);
        for (const { name, cleanup } of cleanups.splice(0).reverse()) await disposeModule(name, cleanup);
      })();
    },
  };
}
