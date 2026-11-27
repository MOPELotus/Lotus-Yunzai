import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createLocalGit, isGitCheckout, type LocalGit } from "./local-git.ts";
import { checkoutUpdateRevision } from "./update-checkout.ts";

async function declarations(git: LocalGit, directory: string) {
  const config = await git(directory, ["config", "--no-includes", "--blob", "HEAD:.gitmodules", "--null", "--get-regexp", "^submodule\\..*\\.(path|url)$"], true);
  const entries = new Map<string, { path?: string; url?: string }>();
  for (const record of (config ?? "").split("\0")) {
    const match = /^submodule\.(.+)\.(path|url)\n([\s\S]+)$/u.exec(record);
    if (!match) continue;
    const item = entries.get(match[1]!) ?? {};
    item[match[2] as "path" | "url"] = match[3];
    entries.set(match[1]!, item);
  }
  return new Map([...entries.values()].flatMap(({ path, url }) => path && url ? [[path, url] as const] : []));
}

// Copy immutable objects into independent checkouts; never share alternates or modify active submodules.
export async function seedUpdateSubmodules(source: string, destination: string, signal?: AbortSignal, depth = 0): Promise<void> {
  signal?.throwIfAborted();
  const git = createLocalGit();
  if (!git || depth > 16) return;
  const [before, after] = await Promise.all([declarations(git, source), declarations(git, destination)]);
  for (const [path, url] of after) {
    signal?.throwIfAborted();
    if (before.get(path) !== url || !path.split("/").every(part => /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(part))) continue;
    const from = join(source, path), to = join(destination, path);
    let physical: string;
    try { physical = await realpath(from); } catch { continue; }
    const within = relative(source, physical);
    if (physical !== from || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`) || !await isGitCheckout(git, from)) continue;
    // Reuse only the declared origin, so changed URLs still go through normal Git submodule synchronization.
    if ((await git(from, ["remote", "get-url", "origin"]))?.trimEnd() !== url) continue;
    const entry = await git(destination, ["ls-tree", "-z", "HEAD", "--", path]);
    const revision = entry && /^160000 commit ([a-f0-9]{40}|[a-f0-9]{64})\t/u.exec(entry)?.[1];
    if (!revision || await git(from, ["cat-file", "-t", revision]) !== "commit\n") continue;
    await mkdir(dirname(to), { recursive: true });
    if (await realpath(dirname(to)) !== dirname(to)) continue;
    await checkoutUpdateRevision(from, revision, to, signal);
    await seedUpdateSubmodules(from, to, signal, depth + 1);
  }
}
