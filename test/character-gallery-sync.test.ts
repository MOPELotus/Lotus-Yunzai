import type { ResourceProgress } from "../lib/resource-progress.ts";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { galleryBlobHash } from "../lib/character-gallery-source.ts";
import { syncedCharacterGalleryPath, syncCharacterGallery } from "../lib/character-gallery-sync.ts";

const main = "Miao-Plugin-MBT";
const genshin = `${main}-2`;
const starrail = `${main}-3`;
const zzz = `${main}-4`;
const fileA = "gs-character/钟离/钟离1.webp";
const fileB = "gs-character/钟离/钟离2.webp";
const fileC = "gs-character/雷电将军/雷电将军.webp";
const fileD = "sr-character/青雀/青雀.webp";
const fileE = "zzz-character/艾莲/艾莲.webp";
const unsafe = "waves-character/漂泊者/漂泊者.webp";
const sourceIndex = "CowCoo/data/AssetData.json";
const sha = (n: number) => n.toString(16).padStart(40, "0");
const webp = (n: number) => Buffer.from(`RIFFabcdWEBP${n}`);
const blob = (path: string, data: Uint8Array, mode = "100644") =>
  ({ path, type: "blob", mode, sha: galleryBlobHash(data), size: data.length });
const dir = (path: string, n: number) => ({ path, type: "tree", mode: "040000", sha: sha(n) });
const indexItem = (path: string, storagebox: string, rated = "none", isBan = false) =>
  ({ path, storagebox, storagebox_type: path.split("/", 1)[0], attributes: { rated, isBan } });

function sourceFixture() {
  let phase = 0;
  let broken = false;
  let binary = false;
  let metadataFailure = false;
  let retry = false;
  const origins: string[] = [];
  const downloads: { path: string; source: string; revision: string }[] = [];
  const expected = new Map<string, Buffer>();
  const objects = new Map<number, ReturnType<typeof dir | typeof blob>[]>();

  const transport = async (url: URL, init: RequestInit) => {
    const [namespace, owner, repo, op, ...rest] = url.pathname.split("/").slice(1).map(decodeURIComponent);
    expect(init.redirect).toBe("error");
    if (url.hostname === "raw.githubusercontent.com") {
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      const path = [op, ...rest].join("/");
      const revision = repo!;
      expect(path).not.toStartWith("waves-character/");
      if (owner === zzz) expect(path).toStartWith("zzz-character/");
      downloads.push({ path, source: owner!, revision });
      const bytes = expected.get(path);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(Uint8Array.from(broken && path === fileC ? webp(8) : bytes));
    }
    expect(namespace).toBe("repos");
    expect(owner).toBe("GuGuNiu");
    expect([main, genshin, starrail, zzz]).toContain(repo!);
    origins.push(url.pathname + url.search);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
    if (op === "commits") {
      expect(rest).toEqual(["main"]);
      if (retry && repo === main) {
        retry = false;
        throw new TypeError("temporary connection error");
      }
      const index = [main, genshin, starrail, zzz].indexOf(repo!);
      return Response.json({ sha: sha(100 + phase * 10 + index), commit: { tree: { sha: sha([1, 2, 3, 10][index]!) } } });
    }
    if (op === "contents") {
      expect(rest.join("/")).toBe(sourceIndex);
      expect(url.searchParams.get("ref")).toBe(sha(100 + phase * 10));
      const rows = [
        indexItem(fileA, genshin), indexItem(fileB, main, "none", phase > 0),
        indexItem(fileD, starrail), indexItem(unsafe, main),
        indexItem(fileE, zzz),
        indexItem("zzz-character/艾莲/艾莲2.webp", zzz, "p18"),
        indexItem("zzz-character/艾莲/艾莲3.webp", zzz, "none", true),
        indexItem("gs-character/刻晴/刻晴2.webp", zzz),
        indexItem("gs-character/钟离/封禁.webp", main, "none", true),
        indexItem("gs-character/钟离/敏感.webp", main, "p18"),
      ];
      if (phase > 0) rows.push(indexItem(fileC, main));
      const bytes = Buffer.from(JSON.stringify(rows));
      return Response.json({ path: sourceIndex, type: "file", encoding: "base64", content: bytes.toString("base64"),
        size: bytes.length, sha: metadataFailure ? sha(999) : galleryBlobHash(bytes) });
    }
    const [endpoint, treeSha] = rest;
    expect(op).toBe("git");
    expect(endpoint).toBe("trees");
    const id = parseInt(treeSha!, 16);
    expect(id).not.toBe(99);
    expect(id).not.toBe(98);
    if (id === 4 && url.search) return Response.json({ sha: treeSha, tree: [], truncated: true });
    const tree = objects.get(id);
    if (!tree) return new Response(null, { status: 404 });
    return Response.json({ sha: treeSha, tree, truncated: false });
  };

  function setup(next: number) {
    phase = next;
    expected.set(fileA, webp(1));
    expected.set(fileB, webp(2));
    expected.set(fileC, binary ? Buffer.from("not an image") : webp(3));
    expected.set(fileD, phase === 0 ? webp(4) : webp(5));
    expected.set(fileE, webp(7));
    objects.set(1, [dir("gs-character", 4), dir("sr-character", 5), dir("waves-character", 99)]);
    objects.set(2, [dir("gs-character", 6)]);
    objects.set(3, [dir("sr-character", 7)]);
    objects.set(4, [dir("钟离", 8), dir("雷电将军", 9)]);
    objects.set(5, []);
    objects.set(6, [blob(fileA.slice("gs-character/".length), expected.get(fileA)!)]);
    objects.set(7, [blob(fileD.slice("sr-character/".length), expected.get(fileD)!)]);
    objects.set(8, [blob("钟离1.webp", webp(9)), blob("钟离2.webp", expected.get(fileB)!),
      blob("封禁.webp", webp(7)), blob("敏感.webp", webp(7)), blob("链接.webp", webp(7), "120000")]);
    objects.set(9, [blob("雷电将军.webp", expected.get(fileC)!)]);
    objects.set(10, [dir("zzz-character", 11), dir("gs-character", 98), dir("waves-character", 99)]);
    objects.set(11, [blob("艾莲/艾莲.webp", expected.get(fileE)!), blob("艾莲/艾莲2.webp", webp(1)), blob("艾莲/艾莲3.webp", webp(1))]);
  }

  setup(0);
  return { transport, downloads, origins, setup,
    change(options: { broken?: boolean; binary?: boolean; metadataFailure?: boolean; retry?: boolean }) {
      broken = options.broken ?? false;
      binary = options.binary ?? false;
      metadataFailure = options.metadataFailure ?? false;
      retry = options.retry ?? false;
      setup(phase);
    },
  };
}

test("图库按旧索引的来源和清洁等级下载，完整快照发布、增量移除、零鸣潮字节", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-gallery-sync-"));
  const root = join(workspace, "character-gallery-synced");
  const source = sourceFixture();
  const active = syncedCharacterGalleryPath(root);
  const progress: ResourceProgress[] = [];
  const run = () => syncCharacterGallery({ root, fetch: source.transport, githubToken: "test-token",
    onProgress(event) { progress.push(event); throw new Error("progress sink unavailable"); } });
  try {
    const initial = await run();
    expect(initial).toMatchObject({ downloaded: 4, reused: 0, removed: 0, files: 4,
      byGame: { "gs-character": 2, "sr-character": 1, "zzz-character": 1 } });
    expect(source.downloads).toContainEqual({ path: fileA, source: genshin, revision: sha(101) });
    expect(source.downloads).toContainEqual({ path: fileE, source: zzz, revision: sha(103) });
    expect(new Set(source.downloads.map(entry => entry.path))).toEqual(new Set([fileA, fileB, fileD, fileE]));
    expect(progress.filter(event => event.stage === "gallery-download").map(event => event.completed)).toEqual([0, 1, 2, 3, 4]);
    expect(progress.findLast(event => event.stage === "gallery-check")).toMatchObject({ completed: initial.files, total: initial.files });
    expect(progress.at(-1)?.stage).toBe("gallery-publish");
    const original = await readlink(active);
    expect(await readFile(join(active, fileA))).toEqual(webp(1));
    expect(await readFile(join(active, fileB))).toEqual(webp(2));
    expect((await readdir(active)).sort()).toEqual(["gallery-manifest.json", "gs-character", "sr-character", "zzz-character"]);
    expect(source.origins.some(url => url.includes(`git/trees/${sha(8)}?recursive=1`))).toBe(true);

    source.downloads.length = 0;
    source.change({ retry: true });
    expect(await run()).toMatchObject({ downloaded: 0, reused: 4, removed: 0 });
    expect(source.downloads).toEqual([]);
    expect(await readlink(active)).toBe(original);

    source.setup(1);
    expect(await run()).toMatchObject({ downloaded: 2, reused: 2, removed: 1, files: 4 });
    expect(new Set(source.downloads.map(entry => entry.path))).toEqual(new Set([fileC, fileD]));
    expect(await readlink(active)).not.toBe(original);
    expect(await Bun.file(join(active, fileB)).exists()).toBe(false);
    expect(await readFile(join(root, original, fileB))).toEqual(webp(2));
    expect(await readFile(join(active, fileD))).toEqual(webp(5));

    source.downloads.length = 0;
    await writeFile(join(active, fileC), webp(6));
    expect(await run()).toMatchObject({ downloaded: 1, reused: 3, removed: 0 });
    expect(source.downloads.map(entry => entry.path)).toEqual([fileC]);
    expect(await readFile(join(active, fileC))).toEqual(webp(3));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("索引、文件校验或取消失败保留原快照，手工图库路径始终独立", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-gallery-rollback-"));
  const imported = join(workspace, "character-gallery");
  const root = join(workspace, "character-gallery-synced");
  const source = sourceFixture();
  const active = syncedCharacterGalleryPath(root);
  const run = (signal?: AbortSignal) => syncCharacterGallery({ root, fetch: source.transport, githubToken: "test-token", signal });
  try {
    await Bun.write(join(imported, unsafe), webp(9));
    await run();
    const original = await readlink(active);
    source.setup(1);
    source.change({ broken: true });
    await expect(run()).rejects.toThrow("Git blob");
    source.change({ binary: true });
    await expect(run()).rejects.toThrow("普通图片");
    source.change({ metadataFailure: true });
    await expect(run()).rejects.toThrow("Git blob");
    await expect(run(AbortSignal.abort())).rejects.toThrow();
    expect(await readlink(active)).toBe(original);
    expect(await readdir(join(root, "snapshots"))).toEqual([original.split("/").at(-1)!]);
    expect(await readFile(join(active, fileB))).toEqual(webp(2));
    expect(await readFile(join(imported, unsafe))).toEqual(webp(9));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
