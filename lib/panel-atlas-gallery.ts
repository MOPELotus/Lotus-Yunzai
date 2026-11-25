import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rasterImageSize } from "@lotus-yunzai/account";

const games = ["gi", "hsr", "zzz"] as const;
type Game = (typeof games)[number];
type GalleryPath = (path: string, game: Game) => boolean;
const maxEntriesPerGame = 25_000;
const maxDepth = 8;
const pageSize = 12;
const maxPreviewBytes = 16 * 1024 ** 2;
const maxPreviewPixels = 48 * 1024 ** 2;
const formats = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"]]);

function readGame(value: string | null): Game | undefined {
  return games.find(game => game === value);
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function collectGallery(
  data: string,
  game: Game,
  matches: GalleryPath,
  signal: AbortSignal,
) {
  const images = new Map<string, number>();
  let visited = 0;

  async function scan(base: string, path: string, depth: number): Promise<void> {
    signal.throwIfAborted();
    if (depth > maxDepth) throw new Error($t("lib.panel-atlas-gallery.text_5e5fc3efd5"));
    const directory = join(base, path);
    const canonical = await realpath(directory).catch(error => {
      if (!missing(error)) throw error;
    });
    if (canonical !== directory) return;

    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted();
      if (++visited > maxEntriesPerGame) throw new Error($t("lib.panel-atlas-gallery.text_5f5f381863"));
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory() && matches(`${name}/sample.png`, game)) {
        await scan(base, name, depth + 1);
      } else if (entry.isFile() && matches(name, game) && !images.has(name)) {
        const info = await lstat(join(base, name)).catch(error => {
          if (!missing(error)) throw error;
        });
        if (info?.isFile() && info.size > 0) images.set(name, info.size);
      }
    }
  }

  const path = `gallery/${game}`;
  await scan(data, path, 0);
  // Legacy Atlas exports may put their gallery alongside the data directory.
  if (basename(data) === "data") await scan(dirname(data), path, 0);
  return images;
}

function browseGallery(
  images: ReadonlyMap<string, number>, game: Game, query: URLSearchParams, version: number | null,
) {
  const prefix = `gallery/${game}/`;
  const filter = query.get("q")?.normalize("NFKC").toLowerCase().trim() ?? "";
  const folder = query.get("folder") ?? "";
  const entries = [...images].map(([path, bytes]) => ({ path: path.slice(prefix.length), bytes }));
  const folders = [...new Set(entries.map(({ path }) => path.includes("/") ? path.split("/")[0]! : ""))]
    .filter(Boolean).sort((left, right) => left.localeCompare(right, "zh-CN"));
  const filtered = entries.filter(({ path }) => (!folder || path.startsWith(`${folder}/`)) &&
    path.normalize("NFKC").toLowerCase().includes(filter));
  filtered.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pages, Number(query.get("page") ?? 1));
  const offset = (page - 1) * pageSize;
  return Response.json({ version, folders, page, pages, total: filtered.length, items: filtered.slice(offset, offset + pageSize) });
}

async function readPreview(data: string, path: string, signal: AbortSignal) {
  const bases = basename(data) === "data" ? [data, dirname(data)] : [data];
  for (const base of bases) {
    signal.throwIfAborted();
    const location = join(base, path);
    const canonical = await realpath(location).catch(error => {
      if (!missing(error)) throw error;
    });
    if (canonical !== location) continue;
    const info = await lstat(location);
    if (!info.isFile() || !info.size) continue;
    const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev ||
          await realpath(location) !== location) continue;
      if (opened.size > maxPreviewBytes) return new Response(null, { status: 413 });
      const bytes = Buffer.alloc(opened.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== opened.size) return new Response(null, { status: 409 });
      const imageBytes = bytes.subarray(0, bytesRead);
      const size = rasterImageSize(imageBytes, formats.get(extname(path).toLowerCase()) ?? "");
      if (!size?.[0] || !size[1] || size[0] * size[1] > maxPreviewPixels) {
        return new Response(null, { status: 422 });
      }
      signal.throwIfAborted();
      const { renderRasterThumbnail } = await import("@lotus-yunzai/skia");
      const thumbnail = await renderRasterThumbnail(imageBytes, 320, maxPreviewPixels);
      signal.throwIfAborted();
      if (!thumbnail) return new Response(null, { status: 422 });
      return new Response(new Uint8Array(thumbnail.png), {
        headers: { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" },
      });
    } finally {
      await handle.close();
    }
  }
  return new Response(null, { status: 404 });
}

export function panelAtlasGallery(root: URL) {
  let previewReads = 0;
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    const query = new URL(request.url).searchParams;
    const view = query.get("view");
    const game = readGame(query.get("game"));
    const folder = query.get("folder");
    const relativePath = query.get("path");
    const path = `gallery/${game}/${relativePath ?? ""}`;
    if (view !== null && (!game || !["browse", "preview"].includes(view))) return new Response(null, { status: 400 });
    if (view === "browse" && ((query.get("q")?.length ?? 0) > 100 || (folder?.length ?? 0) > 250 ||
        !/^[1-9]\d{0,4}$/u.test(query.get("page") ?? "1"))) return new Response(null, { status: 400 });
    if (view === "preview" && (!relativePath || relativePath.length > 1_024 ||
        relativePath.split("/").length > maxDepth + 1)) return new Response(null, { status: 400 });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]);
    try {
      const [{ discoverRuntimeAtlasDataDirectory }, { isAtlasGalleryPath }] = await Promise.all([
        import("../plugins/atlas/legacy-atlas-directory.ts"),
        import("../plugins/atlas/source-values.ts"),
      ]);
      if (view === "preview" && game && !isAtlasGalleryPath(path, game)) return new Response(null, { status: 400 });
      const override = Bun.env.LOTUS_ATLAS_DATA_DIR;
      const data = override ? { root: await realpath(override), version: null } :
        await discoverRuntimeAtlasDataDirectory(fileURLToPath(new URL("data/atlas/", root)));
      if (!(await lstat(data.root)).isDirectory()) throw new Error($t("lib.panel-atlas-gallery.text_bb3c755cf3"));
      let response: Response;
      if (view === "browse" && game) {
        const images = await collectGallery(data.root, game, isAtlasGalleryPath, signal);
        response = browseGallery(images, game, query, data.version);
      } else if (view === "preview") {
        if (query.get("version") !== String(data.version)) return new Response(null, { status: 409 });
        if (previewReads >= 2) return new Response(null, { status: 429 });
        previewReads++;
        try {
          response = await readPreview(data.root, path, signal);
        } finally {
          previewReads--;
        }
      } else {
        const rows = await Promise.all(games.map(async game => {
          const images = await collectGallery(data.root, game, isAtlasGalleryPath, signal);
          let bytes = 0;
          for (const size of images.values()) bytes += size;
          return { game, images: images.size, bytes };
        }));
        response = Response.json({ version: data.version, rows });
      }
      return active() ? response : new Response(null, { status: 401 });
    } catch {
      return new Response(null, { status: active() ? 503 : 401 });
    }
  };
}
