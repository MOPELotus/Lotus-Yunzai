import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { runUpdateProcess } from "./update-build.ts";
import { createLocalGit, gitHead, isGitCheckout, isGitRevision, type LocalGit } from "./local-git.ts";

async function sourceConfig(git: LocalGit, source: string, key: string): Promise<string | undefined> {
  const value = await git(source, ["config", "--local", "--no-includes", "--null", "--get-all", key], true);
  if (value === "") return;
  const parsed = value && /^([^\u0000-\u001f\u007f]+)\0$/u.exec(value)?.[1];
  if (!parsed) throw new Error("更新来源的 Git 配置无法安全保留。");
  return parsed;
}

async function sourceOrigin(git: LocalGit, source: string): Promise<string | undefined> {
  const ref = await git(source, ["symbolic-ref", "--quiet", "HEAD"], true);
  if (ref === undefined) throw new Error("无法检查更新来源的 Git 分支。");
  const branch = ref.trimEnd();
  let remote = "origin";
  if (branch.startsWith("refs/heads/")) {
    const key = `branch.${branch.slice("refs/heads/".length)}`;
    const [upstream, merge] = await Promise.all([
      sourceConfig(git, source, `${key}.remote`), sourceConfig(git, source, `${key}.merge`),
    ]);
    if (upstream && upstream !== "." && merge?.startsWith("refs/heads/")) remote = upstream;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remote)) throw new Error("更新来源的上游名称无效。");
  const url = await sourceConfig(git, source, `remote.${remote}.url`);
  if (!url) return;
  if (/^[^/:]+::/u.test(url) || await git(source, ["remote", "get-url", "--all", remote]) !== `${url}\n`) {
    throw new Error("更新来源的 origin 无法安全保留。");
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (!["file", "git", "http", "https", "ssh"].includes(scheme)) throw new Error("更新来源的 origin 协议不受支持。");
    if (url.includes("?") || url.includes("#")) throw new Error("更新来源的 origin 不支持查询参数或片段。");
    const parsed = new URL(url);
    if (parsed.password || (scheme !== "ssh" && parsed.username)) {
      parsed.password = "";
      if (scheme !== "ssh") parsed.username = "";
      return parsed.href;
    }
    return url;
  }
  // Git SCP syntax is a remote address. Only plain paths are relative to the source checkout.
  return /^(?:[^/@:]+@)?(?:\[[^\]]+\]|[^/:]+):[^:]/u.test(url) && !isAbsolute(url) ? url : resolve(source, url);
}

async function destinationDirectory(source: string, destination: string): Promise<string> {
  const requested = resolve(destination);
  const target = join(await realpath(dirname(requested)), basename(requested));
  const fromSource = relative(source, target);
  if (!fromSource || (!isAbsolute(fromSource) && fromSource !== ".." && !fromSource.startsWith(`..${sep}`))) {
    throw new Error("候选检出目录须与当前工作区独立。");
  }
  try {
    if (!(await lstat(target)).isDirectory() || (await readdir(target)).length) {
      throw new Error("候选检出目录须为空目录。");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    await mkdir(target, { mode: 0o700 });
  }
  return target;
}

async function run(binary: string, cwd: string, args: string[], signal?: AbortSignal): Promise<void> {
  try {
    const command = [binary, "--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...args];
    if (await runUpdateProcess(cwd, {
      PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
    }, command, 45_000, signal)) return;
  } catch {
    signal?.throwIfAborted();
    // Report only which operation failed; Git may print local or remote credentials.
  }
  throw new Error(`无法完成候选 Git ${args[0]} 操作。`);
}

export async function checkoutUpdateRevision(
  source: string, revision: string, destination: string, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const git = createLocalGit();
  const binary = Bun.which("git");
  if (!git || !binary || !isGitRevision(revision) || revision.trim() !== revision) {
    throw new Error("候选检出需要本地 Git 和完整提交号。");
  }

  const directory = await realpath(source);
  const valid = await isGitCheckout(git, directory);
  signal?.throwIfAborted();
  if (!valid) throw new Error("候选来源须为真实 Git 工作区。");
  const type = await git(directory, ["cat-file", "-t", revision]);
  signal?.throwIfAborted();
  if (type?.trim() !== "commit") {
    throw new Error("候选提交在本地 Git 中不可用。");
  }
  const origin = await sourceOrigin(git, directory);
  signal?.throwIfAborted();
  const target = await destinationDirectory(directory, destination);
  await run(binary, target, ["init", "--quiet", "--template=", `--object-format=${revision.length === 64 ? "sha256" : "sha1"}`], signal);
  await run(binary, target, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-gc",
    "--no-recurse-submodules", "--upload-pack=git-upload-pack", "--", pathToFileURL(directory).href, revision], signal);
  await run(binary, target, ["checkout", "--quiet", "--detach", revision, "--"], signal);
  const verify = createLocalGit();
  const expectsDetached = verify && await gitHead(verify, target) === revision &&
    await verify(target, ["symbolic-ref", "--quiet", "HEAD"], true) === "";
  signal?.throwIfAborted();
  if (!expectsDetached) {
    throw new Error("候选检出未到达指定的 detached 提交。");
  }
  if (origin) await run(binary, target, ["remote", "add", "--", "origin", origin], signal);
}
