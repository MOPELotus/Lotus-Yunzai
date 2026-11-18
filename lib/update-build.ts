import { lstat, mkdir } from "node:fs/promises";
import { devNull } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const inheritedVariable = /^(?:LANG|LANGUAGE|LC_[A-Z_]+|TZ|(?:HTTP|HTTPS|ALL|NO)_PROXY|(?:http|https|all|no)_proxy)$/u;

async function run(directory: string, env: NodeJS.ProcessEnv, command: string[], timeout: number, failure: string) {
  try {
    const child = Bun.spawn(command, {
      cwd: directory, env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
    });
    const deadline = setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeout);
    try {
      if (await child.exited === 0) return;
    } finally {
      clearTimeout(deadline);
    }
  } catch {
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
    throw new Error("无法准备更新候选的构建缓存。");
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

export async function initializeUpdateSubmodules(directory: string, cacheDirectory: string): Promise<void> {
  const failure = "更新候选子模块初始化失败。";
  try {
    if (!(await lstat(join(directory, ".gitmodules"))).isFile()) throw new Error(failure);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw new Error(failure);
  }
  const env = await buildEnvironment(cacheDirectory);
  const git = Bun.which("git", { PATH: env.PATH });
  if (!git) throw new Error(failure);
  await run(directory, env, [git, "submodule", "update", "--init", "--recursive", "--checkout"], 15 * 60_000, failure);
}

export async function buildUpdateCheckout(directory: string, cacheDirectory: string): Promise<void> {
  const env = await buildEnvironment(cacheDirectory);
  const command = [process.execPath, "run", "--no-env-file", "--no-orphans"];
  await run(directory, env, [...command, "scripts/bootstrap.ts"], 15 * 60_000, "更新候选初始化失败。");
  await run(directory, env, [...command, "typecheck"], 3 * 60_000, "更新候选类型检查失败。");
}
