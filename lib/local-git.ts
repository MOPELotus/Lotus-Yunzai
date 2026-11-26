import { lstat, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { join, resolve } from "node:path";

export type LocalGit = (directory: string, args: string[], allowEmpty?: boolean) => Promise<string | undefined>;

export function isGitRevision(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

export function createLocalGit(): LocalGit | undefined {
  const binary = Bun.which("git");
  if (!binary) return;
  return async (directory, args, allowEmpty = false) => {
    try {
      const signal = AbortSignal.timeout(10_000);
      const task = Bun.spawn([binary, "--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...args], {
        cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal,
        killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: process.env.PATH, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_NO_REPLACE_OBJECTS: "1",
        },
      });
      const [output, exit] = await Promise.all([new Response(task.stdout).text(), task.exited]);
      if (exit === 0 || (exit === 1 && allowEmpty)) return output;
    } catch {
      return;
    }
  };
}

export async function isGitCheckout(git: LocalGit, directory: string): Promise<boolean> {
  const marker = join(directory, ".git");
  try {
    const info = await lstat(marker);
    if (!info.isDirectory() && !info.isFile()) return false;
    const paths = (await git(directory, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]))?.trimEnd().split("\n");
    if (paths?.length !== 2 || await realpath(paths[0]!) !== directory) return false;
    const gitDirectory = await realpath(paths[1]!);
    if (info.isDirectory()) return gitDirectory === marker;

    // Git reports a copied worktree .git pointer as a distinct top-level directory.
    const backlink = Bun.file(join(gitDirectory, "gitdir"));
    if (await backlink.exists()) return await realpath(resolve(gitDirectory, (await backlink.text()).trimEnd())) === marker;
    const worktree = (await git(directory, ["config", "--local", "--no-includes", "--get", "core.worktree"]))?.trimEnd();
    return !!worktree && await realpath(resolve(gitDirectory, worktree)) === directory;
  } catch {
    return false;
  }
}

export async function gitHead(git: LocalGit, directory: string): Promise<string | undefined> {
  const sha = (await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]))?.trim();
  return sha && isGitRevision(sha) ? sha : undefined;
}
