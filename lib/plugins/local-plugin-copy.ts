import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { cp, lstat, readdir, readlink, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isUpdateDotenvPath } from "../update-activation.ts";

const localCopyExcluded = (name: string) => name === "node_modules" || name === ".git" || isUpdateDotenvPath(name);

async function restoreLocalPluginLink(root: string, path: string, target: string, signal?: AbortSignal) {
  const invalid = () => new Error($t("lib.plugins.local-plugin-copy.text_0509610304"));
  if (isAbsolute(target)) throw invalid();
  let location = dirname(path);
  const parts = target.split(sep);
  for (const [index, part] of parts.entries()) {
    signal?.throwIfAborted();
    if (!part || part === ".") continue;
    if (part === "..") {
      if (location === root) throw invalid();
      location = dirname(location);
      continue;
    }
    if (localCopyExcluded(part)) throw invalid();
    location = join(location, part);
    const info = await lstat(location).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw invalid();
      throw error;
    });
    if (index === parts.length - 1 && info.isFile()) {
      await symlink(target, path);
      return;
    }
    if (!info.isDirectory()) throw invalid();
  }
  throw invalid();
}

export async function copyLocalPlugin(source: string, destination: string, signal?: AbortSignal,
  { exclude = new Set<string>(), rejectSpecialPermissions = false }: {
    readonly exclude?: ReadonlySet<string>;
    readonly rejectSpecialPermissions?: boolean;
  } = {}) {
  signal?.throwIfAborted();
  const root = await lstat(source);
  const links: { path: string; target: string }[] = [];
  await cp(source, destination, {
    recursive: true, force: false, errorOnExist: true, dereference: false,
    async filter(path) {
      signal?.throwIfAborted();
      const subpath = relative(source, path).split(sep).join("/");
      if (path !== source && (localCopyExcluded(basename(path)) || exclude.has(subpath))) return false;
      const info = await lstat(path);
      signal?.throwIfAborted();
      if (path !== source && info.isSymbolicLink()) {
        links.push({ path: join(destination, relative(source, path)), target: await readlink(path) });
        return false;
      }
      if (!info.isDirectory() && !info.isFile()) throw new Error($t("lib.plugins.local-plugin-copy.text_848b968274"));
      if (rejectSpecialPermissions && (info.mode & 0o6000)) throw new Error($t("lib.plugins.local-plugin-copy.text_6ee579373c"));
      return true;
    },
  });
  if (!root.isDirectory()) return;
  // Verify against copied files so excluded or external targets are never read from the live plugin.
  if ((await readdir(destination, { recursive: true, withFileTypes: true })).some(info => !info.isDirectory() && !info.isFile())) {
    throw new Error($t("lib.plugins.local-plugin-copy.text_848b968274"));
  }
  for (const { path, target } of links) await restoreLocalPluginLink(destination, path, target, signal);
}
