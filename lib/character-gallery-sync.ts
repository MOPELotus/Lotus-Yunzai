import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { reportResourceProgress, type ResourceProgressCallback } from "./resource-progress.ts";
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
  readonly onProgress?: ResourceProgressCallback;
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
  if (!info.isSymbolicLink()) throw new Error($t("lib.character-gallery-sync.text_4fd789c9e9"));
  const relative = (await readlink(current)).replaceAll("\\", "/");
  const segments = relative.split("/");
  if (segments.length !== 2 || segments[0] !== snapshotDirectory || !snapshotName.test(segments[1]!)) {
    throw new Error($t("lib.character-gallery-sync.text_8191347343"));
  }
  const name = segments[1]!;
  const directory = join(root, snapshotDirectory, name);
  if (await realpath(current) !== directory || !(await lstat(directory)).isDirectory()) {
    throw new Error($t("lib.character-gallery-sync.text_554e025e12"));
  }
  const manifest = join(directory, manifestFile);
  const manifestStat = await lstat(manifest);
  if (!manifestStat.isFile() || manifestStat.size > 4 * 1024 * 1024) throw new Error($t("lib.character-gallery-sync.text_b5ed8fe710"));
  const parsed = JSON.parse(await readFile(manifest, "utf8")) as Partial<GalleryManifest>;
  const sha = /^[0-9a-f]{40}$/u;
  if (!parsed.revisions || !gallerySourceNames.every(key => sha.test(parsed.revisions?.[key] ?? "")) ||
      !Array.isArray(parsed.images) || !parsed.images.every(validGalleryImage)) {
    throw new Error($t("lib.character-gallery-sync.text_b5ed8fe710"));
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
  const report = (stage: string, message: string, completed?: number, total?: number) => reportResourceProgress(options.onProgress, options.signal, stage, message, completed, total);
  report("gallery-plan", $t("lib.character-gallery-sync.text_29d402ab5d"));
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const configured = resolve(options.root);
  await mkdir(configured, { recursive: true, mode: 0o700 });
  if (!(await lstat(configured)).isDirectory()) throw new Error($t("lib.character-gallery-sync.text_c482a85407"));
  const root = await realpath(configured);
  const lock = await lockFile(join(root, "gallery-sync.sqlite"), $t("lib.character-gallery-sync.text_1f0464b533"));
  try {
    const snapshots = join(root, snapshotDirectory);
    await mkdir(snapshots, { recursive: true, mode: 0o700 });
    if (await realpath(snapshots) !== snapshots) throw new Error($t("lib.character-gallery-sync.text_748c3b6fe4"));
    const previous = await activeSnapshot(root);
    const source = createGallerySource({ fetch: options.fetch, githubToken: options.githubToken, signal });
    const plan = await source.plan();
    const previousImages = new Map(previous?.manifest.images.map(image => [image.path, image]));
    const images = [...plan.images.values()];
    const reusable = new Map<string, string>();
    let checked = 0;
    report("gallery-check", $t("lib.character-gallery-sync.text_aeaa0389de"), 0, images.length);
    await applyParallel(images, controller, signal, async image => {
      try {
        const old = previousImages.get(image.path);
        if (!previous || !old || old.sha !== image.sha) return;
        const path = join(previous.directory, image.path);
        if (await reusableImage(path, image, signal)) reusable.set(image.path, path);
      } finally { report("gallery-check", $t("lib.character-gallery-sync.text_59991aa00b"), ++checked, images.length); }
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
      let completed = 0;
      report("gallery-download", $t("lib.character-gallery-sync.text_08bb4ab749"), 0, images.length);
      await applyParallel(images, controller, signal, async image => {
        const destination = join(staged, image.path);
        await mkdir(dirname(destination), { recursive: true });
        const reuse = reusable.get(image.path);
        if (reuse) await link(reuse, destination);
        else await writeFile(destination, await source.image(image, plan.revisions), { flag: "wx", signal });
        report("gallery-download", $t("lib.character-gallery-sync.text_08bb4ab749"), ++completed, images.length);
      });
      const manifest: GalleryManifest = { revisions: plan.revisions, images };
      await writeFile(join(staged, manifestFile), JSON.stringify(manifest) + "\n", { flag: "wx", signal });
      await symlink(join(snapshotDirectory, generation), next, "dir");
      signal.throwIfAborted();
      report("gallery-publish", $t("lib.character-gallery-sync.text_97a9949b00"));
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
