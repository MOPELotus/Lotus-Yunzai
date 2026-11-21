import { createHash } from "node:crypto";
import { constants, lstatSync, watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export function legacyScriptHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readFlatScript(path: string): Promise<Buffer | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).isFile()) return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ELOOP") throw error;
  }
}

interface WatchOptions {
  readonly signal?: AbortSignal;
  readonly debounceMs?: number;
  readonly relevantFile?: (name: string) => boolean;
}

interface WatchedDirectory {
  readonly path: string;
  identity?: string;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}

function directoryIdentity(path: string): string | undefined {
  try {
    const info = lstatSync(path, { bigint: true });
    if (info.isDirectory()) return String(info.dev) + ":" + String(info.ino);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

export function watchLegacyFiles(
  root: string,
  directories: readonly string[],
  reconcile: (directory: string, signal: AbortSignal) => Promise<void>,
  options: WatchOptions = {},
) {
  const parent = resolve(root);
  const debounce = options.debounceMs ?? 5_000;
  const stopSignal = new AbortController();
  const states = new Map<string, WatchedDirectory>();
  for (const directory of directories) {
    const path = resolve(directory);
    if (dirname(path) === parent) states.set(basename(path), { path });
  }

  const pending = new Set<WatchedDirectory>();
  let parentWatcher: FSWatcher | undefined;
  let running: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const abort = () => { void stop(); };

  function bind(directory: WatchedDirectory, force = false) {
    try {
      const identity = directoryIdentity(directory.path);
      if (!force && identity === directory.identity) return;
      directory.watcher?.close();
      directory.watcher = undefined;
      directory.identity = undefined;
      if (identity === undefined) return;
      const watcher = watch(directory.path, { recursive: false, persistent: false }, (_type, name) => {
        if (directory.watcher === watcher && (name === null || options.relevantFile?.(name) !== false)) schedule(directory);
      });
      watcher.on("error", () => {
        if (directory.watcher !== watcher) return;
        watcher.close();
        directory.watcher = undefined;
        directory.identity = undefined;
        schedule(directory);
      });
      directory.watcher = watcher;
      directory.identity = identity;
    } catch {
      console.warn("[插件] 无法监听旧版插件目录。");
    }
  }

  function run() {
    if (running || stopSignal.signal.aborted) return;
    running = Promise.resolve().then(async () => {
      for (const directory of pending) {
        if (stopSignal.signal.aborted) break;
        pending.delete(directory);
        bind(directory);
        try {
          await reconcile(directory.path, stopSignal.signal);
        } catch {
          if (!stopSignal.signal.aborted) console.warn("[插件] 无法刷新旧版插件目录。");
        }
      }
    }).finally(() => {
      running = undefined;
      if (pending.size) run();
    });
  }

  function schedule(directory: WatchedDirectory) {
    if (stopSignal.signal.aborted) return;
    pending.delete(directory);
    clearTimeout(directory.timer);
    directory.timer = setTimeout(() => {
      directory.timer = undefined;
      pending.add(directory);
      run();
    }, debounce);
  }

  function stop(): Promise<void> {
    if (disposal) return disposal;
    disposal = running ?? Promise.resolve();
    stopSignal.abort(options.signal?.reason);
    options.signal?.removeEventListener("abort", abort);
    parentWatcher?.close();
    for (const directory of states.values()) {
      clearTimeout(directory.timer);
      directory.watcher?.close();
    }
    pending.clear();
    return disposal;
  }

  if (options.signal?.aborted) void stop();
  else if (states.size) {
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      parentWatcher = watch(parent, { recursive: false, persistent: false }, (type, name) => {
        if (stopSignal.signal.aborted) return;
        const affected = name === null ? states.values() : [states.get(name)];
        for (const directory of affected) {
          if (!directory) continue;
          if (type === "rename") bind(directory, true);
          schedule(directory);
        }
      });
      parentWatcher.on("error", () => {
        parentWatcher?.close();
        for (const directory of states.values()) schedule(directory);
      });
    } catch {
      console.warn("[插件] 无法监听插件根目录。");
    }
    for (const directory of states.values()) {
      bind(directory);
      pending.add(directory);
    }
    run();
  }

  return { stop };
}
