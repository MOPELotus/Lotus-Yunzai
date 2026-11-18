import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";
import { createLocalGit, gitHead, isGitCheckout, isGitRevision, type LocalGit } from "./local-git.ts";
import { findLoadedPlugin, loadedPluginPath, type PluginDirectories } from "./plugins/loaded-directories.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";

export interface UpdateHistory {
  readonly name: string;
  readonly lines: readonly string[];
  readonly pinnedMismatch?: boolean;
}

const builtIns = new Set(builtInDirectories.values());

async function pinnedRevision(git: LocalGit, host: string, name: string): Promise<string | undefined> {
  if (!await isGitCheckout(git, host)) return;
  const path = `plugins/${name}`;
  const entry = await git(host, ["ls-tree", "-z", "HEAD", "--", path]);
  const match = entry && /^160000 commit ([0-9a-f]+)\t([^\0]+)\0$/u.exec(entry);
  if (match && match[2] === path && isGitRevision(match[1]!)) return match[1];
}

async function logLines(git: LocalGit, directory: string, revision: string | undefined): Promise<readonly string[] | undefined> {
  if (!revision) return [];
  const output = await git(directory, ["log", "-z", "--no-color", "--no-decorate", "--no-show-signature", "--no-notes",
    "--no-patch", "--max-count=100", "--date=format:%F %T", "--format=%cd%x00%s", revision, "--"]);
  if (output === undefined) return;
  const rows = output.split("\0");
  const lines: string[] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const date = rows[i]!;
    const title = sanitizeRuntimeLog(rows[i + 1]!).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(date) && title && !title.includes("Merge branch")) {
      lines.push(`[${date}] ${title}`);
    }
  }
  return lines;
}

export async function readUpdateHistory(root: URL, directories: PluginDirectories, requested?: string): Promise<UpdateHistory | undefined> {
  const query = requested?.trim();
  const plugin = query ? findLoadedPlugin(directories, query) : undefined;
  if (query && !plugin) return;
  const git = createLocalGit();
  if (!git) return;
  try {
    const host = await realpath(fileURLToPath(root));
    if (!plugin) {
      if (!await isGitCheckout(git, host)) return;
      const lines = await logLines(git, host, await gitHead(git, host));
      return lines === undefined ? undefined : { name: "Lotus-Yunzai", lines };
    }

    const { name } = plugin;
    const directory = await loadedPluginPath(host, plugin);
    if (!directory || !await isGitCheckout(git, directory)) return;
    const actual = await gitHead(git, directory);
    if (!builtIns.has(name)) {
      const lines = await logLines(git, directory, actual);
      return lines === undefined ? undefined : { name, lines };
    }

    const revision = await pinnedRevision(git, host, name);
    if (!revision) return;
    const lines = await logLines(git, directory, revision);
    if (lines === undefined) return;
    return { name, lines, ...(actual !== revision ? { pinnedMismatch: true } : {}) };
  } catch {
    return;
  }
}
