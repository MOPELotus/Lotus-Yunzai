import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";
import { createLocalGit, gitHead, isGitCheckout, isGitRevision, type LocalGit } from "./local-git.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";

export interface UpdateHistory {
  readonly name: string;
  readonly lines: readonly string[];
  readonly pinnedMismatch?: boolean;
}

type Directories = ReadonlyMap<string, { path: string; packageName: string }>;
const builtIns = new Set(builtInDirectories.values());

function resolveModule(directories: Directories, requested: string) {
  const exact = directories.get(requested);
  if (exact) return { name: requested, ...exact };
  const packageMatch = [...directories].find(([, plugin]) => plugin.packageName === requested.toLowerCase());
  if (packageMatch) return { name: packageMatch[0], ...packageMatch[1] };
  for (const suffix of ["-Plugin", "-plugin"]) {
    const name = requested + suffix;
    const candidate = directories.get(name);
    if (candidate) return { name, ...candidate };
  }
}

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

export async function readUpdateHistory(root: URL, directories: Directories, requested?: string): Promise<UpdateHistory | undefined> {
  const query = requested?.trim();
  const plugin = query ? resolveModule(directories, query) : undefined;
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
    if (name === "." || name === ".." || basename(name) !== name || /[\\\u0000-\u001f]/u.test(name)) return;
    const directory = join(host, "plugins", name);
    if (await realpath(plugin.path) !== directory || !await isGitCheckout(git, directory)) return;
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
