import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const galleryDirectories = ["gs-character", "sr-character", "zzz-character"] as const;
export type GalleryDirectory = typeof galleryDirectories[number];

const origin = "https://api.github.com";
const rawOrigin = "https://raw.githubusercontent.com";
const owner = "GuGuNiu";
const indexPath = "CowCoo/data/AssetData.json";
const sources = [
  { name: "Miao-Plugin-MBT", directories: ["gs-character", "sr-character"] },
  { name: "Miao-Plugin-MBT-2", directories: ["gs-character"] },
  { name: "Miao-Plugin-MBT-3", directories: ["sr-character"] },
  { name: "Miao-Plugin-MBT-4", directories: ["zzz-character"] },
] as const;
type SourceName = typeof sources[number]["name"];
export const gallerySourceNames = sources.map(({ name }) => name);
export type GalleryRevisions = Record<SourceName, string>;
export interface GalleryImage {
  readonly path: string;
  readonly source: SourceName;
  readonly sha: string;
  readonly size: number;
}

type Transport = (input: URL, init: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
const maxImageBytes = 32 * 1024 * 1024;

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : {};
}

function component(value: string): boolean {
  return value.length > 0 && !value.startsWith(".") && !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(value) &&
    Buffer.byteLength(value) <= 255;
}

export function validGalleryPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const parts = path.split("/");
  return parts.length === 3 && galleryDirectories.some(name => name === parts[0]) &&
    parts.every(component) && /\.(?:webp|png|jpe?g)$/iu.test(parts[2]!);
}

export function galleryBlobHash(data: Uint8Array): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

export function validGalleryImage(value: unknown): value is GalleryImage {
  const { path, source, sha, size } = object(value);
  return validGalleryPath(path) && sources.some(item => item.name === source &&
    item.directories.some(directory => path.startsWith(directory + "/"))) &&
    typeof sha === "string" && /^[0-9a-f]{40}$/u.test(sha) &&
    typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= maxImageBytes;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function readResponse(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maximum || !response.body) {
    await response.body?.cancel();
    throw new Error($t("lib.character-gallery-source.text_496fc3a47a"));
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new Error($t("lib.character-gallery-source.text_a25e00900c"));
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function gitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) throw new Error($t("lib.character-gallery-source.text_85b6ce6039"));
  return value;
}

function requireBlob(data: Buffer, expected: unknown, size: unknown): void {
  if (data.length !== size || galleryBlobHash(data) !== gitSha(expected)) throw new Error($t("lib.character-gallery-source.text_bfc47cb358"));
}

function hasRasterSignature(data: Buffer): boolean {
  return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ||
    data[0] === 255 && data[1] === 216;
}

export function createGallerySource(options: { fetch?: Transport; githubToken?: string; signal: AbortSignal }) {
  async function request(url: URL, maximum: number): Promise<Buffer> {
    const transport = options.fetch ?? fetch;
    const headers = new Headers({ "User-Agent": "Lotus-Yunzai Character Gallery" });
    if (url.origin === origin) {
      headers.set("Accept", "application/vnd.github+json");
      if (options.githubToken) headers.set("Authorization", `Bearer ${options.githubToken}`);
    }
    for (let attempt = 0; ; attempt++) {
      options.signal.throwIfAborted();
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(45_000)]);
      let response: Response;
      try {
        response = await transport(url, { headers, redirect: "error", signal });
      } catch {
        options.signal.throwIfAborted();
        if (attempt >= 2) throw new Error($t("lib.character-gallery-source.text_ff55ae283f"));
        await delay(250 * 3 ** attempt, undefined, { signal: options.signal });
        continue;
      }
      if (response.ok) return readResponse(response, maximum);
      await response.body?.cancel();
      if (url.origin === origin && (response.status === 403 || response.status === 429) &&
          response.headers.get("x-ratelimit-remaining") === "0") {
        const reset = response.headers.get("x-ratelimit-reset");
        const seconds = reset && /^\d{1,12}$/u.test(reset) ? Number(reset) : undefined;
        const date = seconds !== undefined ? new Date(seconds * 1000) : undefined;
        if (date && Number.isFinite(date.getTime())) {
          const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium", hourCycle: "h23" }).format(date) + " UTC+8";
          throw new Error($t("lib.character-gallery-source.rate-limit", { time }));
        }
        throw new Error($t("lib.character-gallery-source.rate-limit-unknown"));
      }
      if (attempt >= 2 || response.status !== 429 && response.status < 500) {
        throw new Error($t("lib.character-gallery-source.text_5593372bbf", { "status": response.status }));
      }
      await delay(250 * 3 ** attempt, undefined, { signal: options.signal });
    }
  }

  async function api(repo: SourceName, endpoint: string): Promise<Json> {
    const bytes = await request(new URL(`/repos/${owner}/${repo}/${endpoint}`, origin), 8 * 1024 * 1024);
    return object(JSON.parse(bytes.toString("utf8")));
  }

  async function readTree(repo: SourceName, sha: string, recursive: boolean): Promise<{ entries: Json[]; truncated: boolean }> {
    const data = await api(repo, `git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
    if (data.sha !== sha || !Array.isArray(data.tree) || typeof data.truncated !== "boolean") {
      throw new Error($t("lib.character-gallery-source.text_a4dcde43b9"));
    }
    return { entries: data.tree.map(object), truncated: data.truncated };
  }

  async function enumerate(repo: SourceName, prefix: string, sha: string, result: Map<string, GalleryImage>, depth = 0) {
    const recursive = await readTree(repo, sha, true);
    if (!recursive.truncated) {
      for (const entry of recursive.entries) addImage(repo, prefix, entry, result);
      return;
    }
    const direct = await readTree(repo, sha, false);
    if (direct.truncated) throw new Error($t("lib.character-gallery-source.text_34141f3ea1"));
    for (const entry of direct.entries) {
      if (typeof entry.path !== "string" || !component(entry.path)) continue;
      if (entry.type === "tree" && entry.mode === "040000" && depth === 0) {
        await enumerate(repo, `${prefix}/${entry.path}`, gitSha(entry.sha), result, depth + 1);
      } else {
        addImage(repo, prefix, entry, result);
      }
    }
  }

  function addImage(repo: SourceName, prefix: string, entry: Json, result: Map<string, GalleryImage>) {
    if (entry.type !== "blob" || entry.mode !== "100644" && entry.mode !== "100755" || typeof entry.path !== "string") return;
    const image = { path: `${prefix}/${entry.path}`, source: repo, sha: entry.sha, size: entry.size };
    if (validGalleryImage(image)) result.set(image.path, image);
  }

  async function lookup(repo: typeof sources[number], root: string) {
    const indexed = new Map<string, GalleryImage>();
    const tree = await readTree(repo.name, root, false);
    if (tree.truncated) throw new Error($t("lib.character-gallery-source.text_63b86168eb"));
    await Promise.all(repo.directories.map(async directory => {
      const entry = tree.entries.find(item => item.path === directory);
      if (entry?.type !== "tree" || entry.mode !== "040000") throw new Error($t("lib.character-gallery-source.text_40540dbd38"));
      await enumerate(repo.name, directory, gitSha(entry.sha), indexed);
    }));
    return indexed;
  }

  async function readIndex(commit: string): Promise<unknown[]> {
    const data = await api(sources[0].name, `contents/${indexPath}?ref=${commit}`);
    if (data.path !== indexPath || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") {
      throw new Error($t("lib.character-gallery-source.text_29084ea634"));
    }
    const bytes = Buffer.from(data.content, "base64");
    requireBlob(bytes, data.sha, data.size);
    const index: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(index)) throw new Error($t("lib.character-gallery-source.text_166d6c0862"));
    return index;
  }

  return {
    async plan(): Promise<{ revisions: GalleryRevisions; images: Map<string, GalleryImage> }> {
      const commits = await Promise.all(sources.map(async repo => {
        const response = await api(repo.name, "commits/main");
        return { repo, commit: gitSha(response.sha), tree: gitSha(object(object(response.commit).tree).sha) };
      }));
      const [index, trees] = await Promise.all([
        readIndex(commits[0]!.commit),
        Promise.all(commits.map(async entry => [entry.repo.name, await lookup(entry.repo, entry.tree)] as const)),
      ]);
      const images = new Map<string, GalleryImage>();
      const bySource = new Map(trees);
      for (const value of index) {
        const { path, storagebox, storagebox_type, attributes } = object(value);
        if (!validGalleryPath(path) || storagebox_type !== path.split("/", 1)[0] ||
            object(attributes).isBan !== false || object(attributes).rated !== "none") continue;
        const repo = sources.find(item => item.name === storagebox && item.directories.some(directory => directory === storagebox_type));
        if (!repo) continue;
        const image = bySource.get(repo.name)?.get(path);
        if (!image || images.has(path)) throw new Error($t("lib.character-gallery-source.text_5256707029"));
        images.set(path, image);
      }
      const indexedGames = new Set([...images.keys()].map(path => path.split("/", 1)[0]));
      if (!galleryDirectories.every(directory => indexedGames.has(directory))) {
        throw new Error($t("lib.character-gallery-source.text_5cfa6a0133"));
      }
      const revisions = Object.fromEntries(commits.map(({ repo, commit }) => [repo.name, commit])) as GalleryRevisions;
      return { revisions, images };
    },
    async image(image: GalleryImage, revisions: GalleryRevisions): Promise<Buffer> {
      const url = new URL(`/${owner}/${image.source}/${revisions[image.source]}/${encodePath(image.path)}`, rawOrigin);
      const data = await request(url, image.size);
      requireBlob(data, image.sha, image.size);
      if (!hasRasterSignature(data)) throw new Error($t("lib.character-gallery-source.text_be7392a0c1"));
      return data;
    },
  };
}
