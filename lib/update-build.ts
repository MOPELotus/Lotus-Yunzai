import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, mkdir, readFile } from "node:fs/promises";
import { devNull } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { hasNativeSourceMode, nativeBuildCacheRoot } from "./native-build.ts";
import { detectNativeCpu } from "./native-cpu.ts";

const inheritedVariable = /^(?:LANG|LANGUAGE|LC_[A-Z_]+|TZ|(?:HTTP|HTTPS|ALL|NO)_PROXY|(?:http|https|all|no)_proxy)$/u;
interface BuildContinuation { timeout: number; enabled: () => Promise<boolean> }

export async function runUpdateProcess(
  directory: string, env: NodeJS.ProcessEnv, command: string[], timeout: number, signal?: AbortSignal,
  diagnostic?: (result: { code: number; timedOut: boolean; stderr: string }) => void,
  continuation?: BuildContinuation,
): Promise<boolean> {
  signal?.throwIfAborted();
  const child = Bun.spawn(command, {
    cwd: directory, env, stdin: "ignore", stdout: "ignore",
    stderr: diagnostic ? "pipe" : "ignore", detached: true,
  });
  function stop() {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited before the signal.
      }
    }
  }

  let timedOut = false;
  const retained = new Uint8Array(diagnostic ? 64 * 1024 : 0);
  let retainedLength = 0;
  const drained = (async () => {
    if (!diagnostic || !child.stderr) return;
    const reader = child.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const length = Math.min(value.byteLength, retained.length - retainedLength);
        if (length > 0) {
          retained.set(value.subarray(0, length), retainedLength);
          retainedLength += length;
        }
      }
    } catch {
      // Diagnostic capture is best effort.
    } finally {
      reader.releaseLock();
    }
  })();
  const completed = Promise.all([child.exited, drained]);
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  function onAbort() {
    stop();
    rejectAbort(signal!.reason);
  }
  let finished = false;
  const expire = () => {
    timedOut = true;
    stop();
  };
  let deadline = setTimeout(async () => {
    let extend = false;
    try { extend = Boolean(continuation && await continuation.enabled()); } catch {}
    if (finished) return;
    if (extend) deadline = setTimeout(expire, continuation!.timeout);
    else expire();
  }, timeout);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    const [code] = await Promise.race([completed, aborted]);
    signal?.throwIfAborted();
    diagnostic?.({
      code, timedOut,
      stderr: new TextDecoder().decode(retained.subarray(0, retainedLength)),
    });
    return code === 0;
  } finally {
    finished = true;
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function run(
  directory: string, env: NodeJS.ProcessEnv, command: string[], timeout: number, failure: string, signal?: AbortSignal,
  continuation?: BuildContinuation,
) {
  try {
    if (await runUpdateProcess(directory, env, command, timeout, signal, undefined, continuation)) return;
  } catch {
    signal?.throwIfAborted();
    // Keep candidate output and system paths out of host replies.
  }
  throw new Error(failure);
}

async function buildEnvironment(cacheDirectory: string): Promise<NodeJS.ProcessEnv> {
  const cache = resolve(cacheDirectory);
  const config = join(cache, "config");
  try {
    await mkdir(config, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error($t("lib.update-build.text_9ed01485eb"));
  }

  const path = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritedVariable.test(key))),
    PATH: [dirname(process.execPath), ...path].join(delimiter),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    NPM_CONFIG_USERCONFIG: devNull,
    BUN_INSTALL_CACHE_DIR: cache,
    BUN_FEATURE_FLAG_NO_ORPHANS: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: devNull,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentityAgent=none -o IdentityFile=none",
  };
}

export async function initializeUpdateSubmodules(
  directory: string, cacheDirectory: string, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const failure = $t("lib.update-build.text_a09adc2561");
  try {
    if (!(await lstat(join(directory, ".gitmodules"))).isFile()) throw new Error(failure);
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw new Error(failure);
  }
  const env = await buildEnvironment(cacheDirectory);
  const git = Bun.which("git", { PATH: env.PATH });
  if (!git) throw new Error(failure);
  await run(directory, env, [git, "submodule", "update", "--init", "--recursive", "--checkout"], 15 * 60_000, failure, signal);
}

export async function buildUpdateCheckout(
  directory: string, cacheDirectory: string, signal?: AbortSignal,
  preparePlugins?: () => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  const env = await buildEnvironment(cacheDirectory);
  const command = [process.execPath, "run", "--no-env-file", "--no-orphans"];
  env.LOTUS_NATIVE_BUILD_ROOT = nativeBuildCacheRoot();
  const cpu = await detectNativeCpu();
  await run(directory, env, [...command, "scripts/bootstrap.ts", "--build-only"], 15 * 60_000, $t("lib.update-build.text_a8f50a0fa8"), signal,
    { timeout: (8 * 60 - 15) * 60_000, enabled: () => hasNativeSourceMode(env.LOTUS_NATIVE_BUILD_ROOT!, cpu) });
  signal?.throwIfAborted();
  await preparePlugins?.();
  signal?.throwIfAborted();
  await run(directory, env, [...command, "typecheck"], 3 * 60_000, $t("lib.update-build.text_2e6459b265"), signal);
}

async function optionalPhysicalFile(path: string, failure: string): Promise<boolean> {
  try {
    if ((await lstat(path)).isFile()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
  }
  throw new Error(failure);
}

async function hasRuntimeDependencies(path: string): Promise<boolean> {
  const failure = $t("lib.update-build.text_349138106a");
  let metadata: unknown;
  try {
    metadata = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error(failure);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(failure);

  let declared = false;
  for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = (metadata as Record<string, unknown>)[kind];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error(failure);
    declared ||= Object.keys(dependencies).length > 0;
  }
  return declared;
}

export async function buildExternalPluginCheckout(
  directory: string, cacheDirectory: string, requireLock: boolean, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const locks = await Promise.all(["bun.lock", "bun.lockb"].map((file) =>
    optionalPhysicalFile(join(directory, file), $t("lib.update-build.text_dbc00fe1c7"))));
  signal?.throwIfAborted();
  const locked = locks.some(Boolean);
  if (!locked && !requireLock) return;

  const manifest = join(directory, "package.json");
  if (!await optionalPhysicalFile(manifest, $t("lib.update-build.text_9ffb8ae118"))) return;
  if (!locked) {
    if (await hasRuntimeDependencies(manifest)) throw new Error($t("lib.update-build.text_4f4c8a4341"));
    signal?.throwIfAborted();
    return;
  }

  const env = await buildEnvironment(cacheDirectory);
  await run(directory, env, [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--no-env-file",
    "--backend=copyfile"], 3 * 60_000, $t("lib.update-build.text_d0575d163b"), signal);
}
