import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createGallerySource, galleryBlobHash, galleryDirectories, gallerySourceNames, validGalleryImage,
  type GalleryDirectory, type GalleryImage, type GalleryRevisions,
} from "./character-gallery-source.ts";
import { lockFile } from "./file-lock.ts";

export interface CharacterGallerySyncOptions {
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly githubToken?: string;
}

export interface CharacterGallerySyncResult {
  readonly downloaded: number;
  readonly reused: number;
  readonly removed: number;
  readonly files: number;
  readonly byGame: Readonly<Record<GalleryDirectory, number>>;
  readonly revisions: GalleryRevisions;
}

interface GalleryManifest {
  readonly revisions: GalleryRevisions;
  readonly images: readonly GalleryImage[];
}

const snapshotName = /^gallery-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const snapshotDirectory = "snapshots";
const manifestFile = "gallery-manifest.json";
const concurrency = 6;

export function syncedCharacterGalleryPath(root: string): string {
  return join(root, "current");
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function activeSnapshot(root: string) {
  const current = syncedCharacterGalleryPath(root);
  const info = await lstat(current).catch(error => {
    if (!missing(error)) throw error;
  });
  if (!info) return;
  if (!info.isSymbolicLink()) throw new Error("托管图库当前路径须由同步器管理。");
  const relative = (await readlink(current)).replaceAll("\\", "/");
  const segments = relative.split("/");
  if (segments.length !== 2 || segments[0] !== snapshotDirectory || !snapshotName.test(segments[1]!)) {
    throw new Error("托管图库当前指针无效。");
  }
  const name = segments[1]!;
  const directory = join(root, snapshotDirectory, name);
  if (await realpath(current) !== directory || !(await lstat(directory)).isDirectory()) {
    throw new Error("托管图库当前目录无效。");
  }
  const manifest = join(directory, manifestFile);
  const manifestStat = await lstat(manifest);
  if (!manifestStat.isFile() || manifestStat.size > 4 * 1024 * 1024) throw new Error("托管图库记录无效。");
  const parsed = JSON.parse(await readFile(manifest, "utf8")) as Partial<GalleryManifest>;
  const sha = /^[0-9a-f]{40}$/u;
  if (!parsed.revisions || !gallerySourceNames.every(key => sha.test(parsed.revisions?.[key] ?? "")) ||
      !Array.isArray(parsed.images) || !parsed.images.every(validGalleryImage)) {
    throw new Error("托管图库记录无效。");
  }
  return { name, directory, manifest: parsed as GalleryManifest };
}

async function reusableImage(path: string, image: GalleryImage, signal: AbortSignal): Promise<boolean> {
  try {
    if (await realpath(path) !== path) return false;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== image.size) return false;
      const bytes = await file.readFile();
      signal.throwIfAborted();
      return galleryBlobHash(bytes) === image.sha;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (!missing(error) && (error as NodeJS.ErrnoException)?.code !== "ELOOP") throw error;
    return false;
  }
}

async function applyParallel<T>(values: readonly T[], controller: AbortController, signal: AbortSignal,
  apply: (value: T) => Promise<void>): Promise<void> {
  const items = values[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    try {
      for (const item of items) {
        signal.throwIfAborted();
        await apply(item);
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  });
  await Promise.allSettled(workers);
  signal.throwIfAborted();
}

export async function syncCharacterGallery(options: CharacterGallerySyncOptions): Promise<CharacterGallerySyncResult> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const configured = resolve(options.root);
  await mkdir(configured, { recursive: true, mode: 0o700 });
  if (!(await lstat(configured)).isDirectory()) throw new Error("托管图库根须为独立目录。");
  const root = await realpath(configured);
  const lock = await lockFile(join(root, "gallery-sync.sqlite"), "角色图库");
  try {
    const snapshots = join(root, snapshotDirectory);
    await mkdir(snapshots, { recursive: true, mode: 0o700 });
    if (await realpath(snapshots) !== snapshots) throw new Error("托管图库快照目录无效。");
    const previous = await activeSnapshot(root);
    const source = createGallerySource({ fetch: options.fetch, githubToken: options.githubToken, signal });
    const plan = await source.plan();
    const previousImages = new Map(previous?.manifest.images.map(image => [image.path, image]));
    const images = [...plan.images.values()];
    const reusable = new Map<string, string>();
    await applyParallel(images, controller, signal, async image => {
      const old = previousImages.get(image.path);
      if (!previous || !old || old.sha !== image.sha) return;
      const path = join(previous.directory, image.path);
      if (await reusableImage(path, image, signal)) reusable.set(image.path, path);
    });
    const result: CharacterGallerySyncResult = {
      downloaded: images.length - reusable.size,
      reused: reusable.size,
      removed: [...previousImages.keys()].filter(path => !plan.images.has(path)).length,
      files: images.length,
      byGame: {
        "gs-character": images.filter(image => image.path.startsWith("gs-character/")).length,
        "sr-character": images.filter(image => image.path.startsWith("sr-character/")).length,
        "zzz-character": images.filter(image => image.path.startsWith("zzz-character/")).length,
      },
      revisions: plan.revisions,
    };
    if (previous && !result.downloaded && !result.removed &&
        gallerySourceNames.every(repo => previous.manifest.revisions[repo] === plan.revisions[repo])) {
      return result;
    }

    const generation = `gallery-${crypto.randomUUID()}`;
    const staged = join(snapshots, generation);
    const next = join(root, `.${generation}`);
    let published = false;
    try {
      await mkdir(staged, { mode: 0o700 });
      await Promise.all(galleryDirectories.map(directory => mkdir(join(staged, directory), { mode: 0o700 })));
      await applyParallel(images, controller, signal, async image => {
        const destination = join(staged, image.path);
        await mkdir(dirname(destination), { recursive: true });
        const reuse = reusable.get(image.path);
        if (reuse) await link(reuse, destination);
        else await writeFile(destination, await source.image(image, plan.revisions), { flag: "wx", signal });
      });
      const manifest: GalleryManifest = { revisions: plan.revisions, images };
      await writeFile(join(staged, manifestFile), JSON.stringify(manifest) + "\n", { flag: "wx", signal });
      await symlink(join(snapshotDirectory, generation), next, "dir");
      signal.throwIfAborted();
      await rename(next, syncedCharacterGalleryPath(root));
      published = true;
    } finally {
      await rm(next, { force: true });
      if (!published) await rm(staged, { recursive: true, force: true });
    }
    // Keep the immediately preceding snapshot available to renders that started before publication.
    const entries = await readdir(snapshots, { withFileTypes: true }).catch(() => []);
    await Promise.allSettled(entries.filter(entry => entry.isDirectory() && snapshotName.test(entry.name) &&
      entry.name !== generation && entry.name !== previous?.name).map(entry =>
      rm(join(snapshots, entry.name), { recursive: true, force: true })));
    return result;
  } finally {
    lock.close();
  }
}
