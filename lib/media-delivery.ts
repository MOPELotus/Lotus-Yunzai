import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isChatFileName, type ChatFileResult } from "./chat-files.ts";

type MediaKind = "image" | "video" | "record" | "file";
export interface MediaDelivery {
  readonly path: string;
  readonly name: string;
  readonly type: MediaKind;
}

export const sendSessionMedia = Symbol("sendSessionMedia");
export type SendSessionMedia = (url: string, name: string, type: MediaKind) => Promise<ChatFileResult>;

const route = /^\/Media\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const spoolName = /^\.media-delivery-([1-9]\d{0,8})-[A-Za-z0-9]{6}$/u;
const duration = 180_000;
const maxSize = 1024 ** 3;
const mediaTaskPlatforms = ["bilibili", "douyin", "music", "miyoushe", "acfun", "pipixia", "kuaishou", "public-share"] as const;
const contentTypes: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".flv": "video/x-flv", ".mov": "video/quicktime", ".m4v": "video/mp4",
  ".wav": "audio/wav",
};
const privateHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

interface Entry {
  readonly path: string;
  readonly headers: Headers;
  readonly size: number;
  readonly expiry: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createMediaDelivery(dataDirectory: string, baseUrl: () => URL | undefined, ttl = duration) {
  const entries = new Map<string, Entry>();
  let directory: Promise<string> | undefined;
  let occupied = 0;
  let count = 0;
  let closed = false;

  async function prepareDirectory() {
    await mkdir(dataDirectory, { recursive: true });
    const siblings = await readdir(dataDirectory, { withFileTypes: true });
    for (const sibling of siblings) {
      const owner = Number(spoolName.exec(sibling.name)?.[1]);
      if (!sibling.isDirectory() || !owner) continue;
      try { process.kill(owner, 0); continue; } catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      const previous = join(dataDirectory, sibling.name);
      const stat = await lstat(previous).catch(() => undefined);
      if (stat?.isDirectory() && Date.now() - stat.mtimeMs > duration) {
        const stale = await readdir(previous, { withFileTypes: true }).catch(() => undefined);
        if (stale?.every(file => file.isFile() && route.test(`/Media/${file.name}`))) {
          await rm(previous, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
    return mkdtemp(join(dataDirectory, `.media-delivery-${process.pid}-`));
  }

  async function sourceFile(path: string) {
    if (!isAbsolute(path) || basename(path).startsWith(".")) return;
    const task = dirname(path);
    const parent = dirname(task);
    if (!/^task-[A-Za-z0-9]+$/u.test(basename(task)) ||
        !mediaTaskPlatforms.some(platform => resolve(parent) === join(dataDirectory, platform, "tasks"))) return;
    const [parentPath, taskPath, file] = await Promise.all([realpath(parent), realpath(task), realpath(path)]);
    if (relative(parentPath, taskPath) !== basename(task) || file !== `${taskPath}${sep}${basename(path)}`) return;
    const marker = join(taskPath, ".lotus-media-task.json");
    const [stat, markerStat] = await Promise.all([lstat(file), lstat(marker)]);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxSize || !markerStat.isFile() || markerStat.size > 4096) return;
    const owner = JSON.parse(await readFile(marker, "utf8"));
    if (owner?.version === 1 && owner.pid === process.pid) return { file, stat };
  }

  async function expire(token: string) {
    const entry = entries.get(token);
    if (!entry) return;
    entries.delete(token);
    clearTimeout(entry.timer);
    count--;
    occupied -= entry.size;
    await rm(entry.path, { force: true }).catch(() => undefined);
  }

  async function deliver({ path, type, name }: MediaDelivery, send: SendSessionMedia): Promise<ChatFileResult> {
    const base = baseUrl();
    if (closed || !base || !isChatFileName(name) || typeof path !== "string" ||
        (type !== "image" && type !== "video" && type !== "record" && type !== "file")) return "rejected";
    const source = await sourceFile(path).catch(() => undefined);
    if (!source || closed || occupied + source.stat.size > maxSize || count >= 32) return "rejected";
    const mime = type === "file" ? "application/octet-stream" : contentTypes[extname(path).toLowerCase()];
    if (!mime || (type !== "file" && !mime.startsWith(`${type === "record" ? "audio" : type}/`))) return "rejected";
    occupied += source.stat.size;
    count++;
    const token = crypto.randomUUID();
    let target: string | undefined;
    try {
      directory ??= prepareDirectory().catch((error) => { directory = undefined; throw error; });
      target = join(await directory, token);
      if (closed) throw new Error("媒体递送已关闭。");
      await link(source.file, target);
      const linked = await lstat(target);
      if (closed || !linked.isFile() || linked.ino !== source.stat.ino || linked.dev !== source.stat.dev || linked.size !== source.stat.size) {
        throw new Error("媒体文件在递送前发生变化。");
      }
      entries.set(token, {
        path: target, size: linked.size, expiry: performance.now() + ttl,
        timer: setTimeout(() => void expire(token), ttl).unref(),
        headers: new Headers({ ...privateHeaders, "Content-Type": mime, "Content-Length": String(linked.size) }),
      });
    } catch {
      if (target) await rm(target, { force: true }).catch(() => undefined);
      occupied -= source.stat.size;
      count--;
      return "rejected";
    }
    try {
      const result = await send(new URL(`Media/${token}`, base).href, name, type);
      if (result === "rejected") await expire(token);
      return result;
    } catch {
      return "unknown";
    }
  }

  function handle(request: Request): Response | undefined {
    const { pathname, search } = new URL(request.url);
    if (pathname !== "/Media" && !pathname.startsWith("/Media/")) return;
    const token = !search ? route.exec(pathname)?.[1] : undefined;
    const entry = token && !closed ? entries.get(token) : undefined;
    if (!entry || entry.expiry <= performance.now()) return new Response(null, { status: 404, headers: privateHeaders });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: "GET, HEAD" } });
    }
    return new Response(request.method === "HEAD" ? null : Bun.file(entry.path), { headers: entry.headers });
  }

  return {
    deliver,
    handle,
    async close() {
      closed = true;
      await Promise.all([...entries.keys()].map(expire));
      const path = await directory?.catch(() => undefined);
      if (path) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
