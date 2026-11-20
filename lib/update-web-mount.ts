import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readServerWebMount, type WebMountSettings } from "./server.ts";
import { resolveLinkedPath } from "./update-linked-path.ts";

const persistent = new Set(["config", "data", "logs", "internal"]);
const sourceError = "端口挂载的原版目录须位于 Lotus-Yunzai 安装目录外，才能安全切换版本。";
const socketError = "端口挂载 RPC socket 须使用安装目录外或可完整交接的独占运行目录，才能安全切换版本。";

export class WebMountUpdateError extends Error {}

function installedPath(root: string, value: string): string | undefined {
  const path = relative(root, resolve(value));
  if (isAbsolute(path) || path === ".." || path.startsWith(".." + sep)) return;
  return path;
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

async function info(path: string) {
  return lstat(path).catch(error => {
    if (!missing(error)) throw error;
  });
}

async function physical(path: string) {
  return realpath(path).catch(error => {
    if (!missing(error)) throw error;
  });
}

async function retainedInArchive(root: string, previous: string, directory: string): Promise<boolean> {
  const found = await resolveLinkedPath(directory, {
    async match(target) {
      const installed = installedPath(root, target);
      return installed !== undefined && Boolean(await info(join(previous, installed)));
    },
  });
  return found !== undefined;
}

async function verifySource(root: string, directory: string, previous?: string) {
  const path = installedPath(root, directory);
  const resolved = await physical(directory);
  if (resolved && (path !== undefined || installedPath(root, resolved) !== undefined ||
      (previous && installedPath(previous, resolved) !== undefined))) throw new WebMountUpdateError(sourceError);
  if (previous && await retainedInArchive(root, previous, directory)) throw new WebMountUpdateError(sourceError);
}

async function managedSocketDirectory(root: string, socket: string) {
  const parent = dirname(socket);
  const path = installedPath(root, parent);
  const resolved = await physical(parent);
  if (path === undefined) {
    if (resolved && installedPath(root, resolved) !== undefined) throw new WebMountUpdateError(socketError);
    return;
  }
  if (!path || (resolved && parent !== resolved)) throw new WebMountUpdateError(socketError);
  // The activation already moves these ancestors. Never add overlapping paths.
  if (persistent.has(path.split(sep)[0]!)) return;
  const parentInfo = await info(parent);
  if (!parentInfo) return;
  const uid = process.getuid?.();
  if (!parentInfo.isDirectory() || parentInfo.uid !== uid || (parentInfo.mode & 0o7777) !== 0o700) {
    throw new WebMountUpdateError(socketError);
  }

  const endpoint = basename(socket);
  const lock = endpoint + ".lock.sqlite3";
  for (const entry of await readdir(parent)) {
    const entryInfo = await info(join(parent, entry));
    if (!entryInfo) continue;
    const allowed = entry === endpoint
      ? entryInfo.isSocket() && (entryInfo.mode & 0o7777) === 0o600
      : [lock, lock + "-journal", lock + "-wal", lock + "-shm"].includes(entry) && entryInfo.isFile();
    if (!allowed || entryInfo.uid !== uid || (entryInfo.mode & 0o077) !== 0) throw new WebMountUpdateError(socketError);
  }
  return path.split(sep).join("/");
}

export async function readWebMountUpdatePaths(rootUrl: URL): Promise<string[]> {
  const webMount = await readServerWebMount(rootUrl);
  if (!webMount) return [];
  const root = fileURLToPath(rootUrl);
  // The original Node watcher reopens this path. An absent config during rename can clear its live routes.
  await verifySource(root, webMount.directory);
  const runtime = await managedSocketDirectory(root, webMount.socket);
  return runtime ? [runtime] : [];
}

export async function verifyMovedWebMount(root: string, previous: string, webMount?: WebMountSettings): Promise<void> {
  if (!webMount) return;
  await verifySource(root, webMount.directory, previous);
  const parent = dirname(webMount.socket);
  if (await retainedInArchive(root, previous, parent)) throw new WebMountUpdateError(socketError);
  await managedSocketDirectory(root, webMount.socket);
}
