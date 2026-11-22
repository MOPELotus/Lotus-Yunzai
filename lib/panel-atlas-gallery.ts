import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const games = ["gi", "hsr", "zzz"] as const;
type Game = (typeof games)[number];
type GalleryRow = { game: Game; images: number; bytes: number };
const maxEntriesPerGame = 25_000;
const maxDepth = 8;

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function collectGallery(
  data: string,
  game: Game,
  matches: (path: string, game: Game) => boolean,
  signal: AbortSignal,
): Promise<GalleryRow> {
  const images = new Map<string, number>();
  let visited = 0;

  async function scan(base: string, path: string, depth: number): Promise<void> {
    signal.throwIfAborted();
    if (depth > maxDepth) throw new Error("图鉴图库目录超出扫描深度。");
    const directory = join(base, path);
    const canonical = await realpath(directory).catch(error => {
      if (!missing(error)) throw error;
    });
    if (canonical !== directory) return;

    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted();
      if (++visited > maxEntriesPerGame) throw new Error("图鉴图库条目超出扫描上限。");
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
  let bytes = 0;
  for (const size of images.values()) bytes += size;
  return { game, images: images.size, bytes };
}

export function panelAtlasGallery(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]);
    try {
      const [{ discoverRuntimeAtlasDataDirectory }, { isAtlasGalleryPath }] = await Promise.all([
        import("../plugins/atlas/legacy-atlas-directory.ts"),
        import("../plugins/atlas/source-values.ts"),
      ]);
      const override = Bun.env.LOTUS_ATLAS_DATA_DIR;
      const data = override ? { root: await realpath(override), version: null } :
        await discoverRuntimeAtlasDataDirectory(fileURLToPath(new URL("data/atlas/", root)));
      if (!(await lstat(data.root)).isDirectory()) throw new Error("图鉴数据目录不可用。");
      const rows = await Promise.all(games.map(game => collectGallery(data.root, game, isAtlasGalleryPath, signal)));
      if (!active()) return new Response(null, { status: 401 });
      return Response.json({ version: data.version, rows });
    } catch {
      return new Response(null, { status: active() ? 503 : 401 });
    }
  };
}
