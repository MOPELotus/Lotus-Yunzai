import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PluginLoadReport } from "./loader.ts";

export type PluginDirectories = PluginLoadReport["directories"];
type LoadedPlugin = { name: string; path: string; packageName: string };

export function findLoadedPlugin(directories: PluginDirectories, requested: string): LoadedPlugin | undefined {
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

export async function loadedPluginPath(host: string, plugin: LoadedPlugin): Promise<string | undefined> {
  const { name } = plugin;
  if (!name || name === "." || name === ".." || basename(name) !== name || /[\\\u0000-\u001f]/u.test(name)) return;
  const directory = join(host, "plugins", name);
  try {
    if (await realpath(plugin.path) === directory) return directory;
  } catch {
    return;
  }
}
