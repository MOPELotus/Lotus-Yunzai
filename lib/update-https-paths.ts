import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readServerHttpsPaths } from "./server.ts";

type HttpsPaths = NonNullable<Awaited<ReturnType<typeof readServerHttpsPaths>>>;
const persistent = new Set(["config", "data", "logs", "internal"]);

function installedPath(root: string, configured: string): string | undefined {
  const path = relative(root, resolve(root, configured));
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(".." + sep)) return;
  return path.split(sep).join("/");
}

function additionalPath(path: string): boolean {
  const first = path.split("/")[0]!;
  return !persistent.has(first) && first !== ".env" && !first.startsWith(".env.");
}

function missingPath(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function pathInfo(path: string, follow = false) {
  try {
    return await (follow ? stat(path) : lstat(path));
  } catch (error) {
    if (!missingPath(error)) throw error;
  }
}

function installedHttpsPaths(root: string, https?: HttpsPaths): string[] {
  if (!https) return [];
  return [...new Set([https.key, https.cert].flatMap(configured => {
    const path = installedPath(root, configured);
    return path ? [path] : [];
  }))];
}

export async function readManagedHttpsPaths(rootUrl: URL): Promise<string[]> {
  const root = fileURLToPath(rootUrl);
  const paths = installedHttpsPaths(root, await readServerHttpsPaths(rootUrl));
  const state = new Set<string>();
  for (const path of paths) {
    const file = join(root, path);
    if (!(await pathInfo(file, true))?.isFile()) continue;
    if (additionalPath(path)) state.add(path);
    const resolved = await realpath(file).catch(error => {
      if (!missingPath(error)) throw error;
      return undefined;
    });
    const target = resolved && installedPath(root, resolved);
    if (target && additionalPath(target)) state.add(target);
  }
  return [...state];
}

async function retainedArchivePath(root: string, previous: string, path: string): Promise<boolean> {
  if (additionalPath(path) && (await pathInfo(join(previous, path), true))?.isFile()) return true;
  // An absolute link stored in the old checkout can still point at the new checkout after renaming.
  for (const directory of [previous, root]) {
    const parts = path.split("/");
    let link = directory;
    for (let i = 0; i < parts.length; i++) {
      link = join(link, parts[i]!);
      const info = await pathInfo(link);
      if (!info) break;
      if (!info.isSymbolicLink()) continue;
      const target = resolve(dirname(link), await readlink(link), ...parts.slice(i + 1));
      const relativeTarget = installedPath(root, target) ?? installedPath(previous, target);
      if (relativeTarget && additionalPath(relativeTarget) && (await pathInfo(join(previous, relativeTarget), true))?.isFile()) return true;
      break;
    }
  }
  return false;
}

export async function verifyMovedHttpsPaths(root: string, previous: string, https?: HttpsPaths): Promise<void> {
  const message = $t("lib.update-https-paths.text_fafdd0831d");
  for (const path of installedHttpsPaths(root, https)) {
    if (await retainedArchivePath(root, previous, path)) throw new Error(message);
  }
}
