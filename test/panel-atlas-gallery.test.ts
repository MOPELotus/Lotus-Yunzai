import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelAtlasGallery } from "../lib/panel-atlas-gallery.ts";
import { panelApi } from "../lib/panel.ts";

const endpoint = "/panel/api/settings/atlas/gallery";
const authorization = { Authorization: "Bearer gallery-fixture" };

test("owner inventory counts unique gallery files from the active Atlas snapshot only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-inventory-"));
  const atlas = join(directory, "data", "atlas");
  const data = join(atlas, "snapshots", "52", "data");
  const inventory = panelAtlasGallery(pathToFileURL(`${directory}/`));
  const api = panelApi("gallery-fixture", [], path => path === endpoint ? inventory : undefined);
  const request = (options?: RequestInit) => api(new Request(`http://panel.local${endpoint}?source=outside`, options));
  const makeFile = async (path: string, size: number) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, new Uint8Array(size));
  };
  try {
    await makeFile(join(data, "gallery", "gi", "武器", "青.png"), 12);
    await makeFile(join(data, "gallery", "gi", "empty.png"), 0);
    await makeFile(join(data, "gallery", "gi", "index.json"), 14);
    await makeFile(join(data, "gallery", "zzz", "SuitBranch&BladeSong.webp"), 6);
    await makeFile(join(data, "gallery", "bh3", "ignored.png"), 53);
    await makeFile(join(data, "..", "gallery", "gi", "武器", "青.png"), 50);
    await makeFile(join(data, "..", "gallery", "gi", "old-layout.jpg"), 4);
    await makeFile(join(atlas, "snapshots", "53", "data", "gallery", "gi", "staged.png"), 27);
    await makeFile(join(directory, "outside", "private.png"), 99);
    await symlink(join(directory, "outside"), join(data, "gallery", "hsr"));
    await symlink(join(directory, "outside", "private.png"), join(data, "gallery", "gi", "link.png"));
    await symlink("snapshots/52/data", join(atlas, "current"));

    expect((await request())?.status).toBe(401);
    expect((await request({ method: "PUT", headers: authorization }))?.status).toBe(405);
    const response = await request({ headers: authorization });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.json()).toEqual({ version: 52, rows: [
      { game: "gi", images: 2, bytes: 16 },
      { game: "hsr", images: 0, bytes: 0 },
      { game: "zzz", images: 1, bytes: 6 },
    ] });

    let authorizationChecks = 0;
    const revoked = await inventory(new Request(`http://panel.local${endpoint}`), () => ++authorizationChecks === 1);
    expect(revoked.status).toBe(401);
    await rm(join(atlas, "current"));
    await symlink(".atlas-reset", join(atlas, "current"));
    expect((await request({ headers: authorization }))?.status).toBe(503);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner browse filters and paginates the selected game, then previews only images from the same version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-browse-"));
  const atlas = join(directory, "data", "atlas");
  const version = join(atlas, "snapshots", "52");
  const gallery = join(version, "data", "gallery");
  const inventory = panelAtlasGallery(pathToFileURL(`${directory}/`));
  const api = panelApi("gallery-fixture", [], path => path === endpoint ? inventory : undefined);
  const request = (params: Record<string, string>, headers = authorization) =>
    api(new Request(`http://panel.local${endpoint}?${new URLSearchParams(params)}`, { headers }));
  const add = async (path: string, value: Uint8Array | string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mMU1TBjYGBgYmBgQFAACLwAebTfQhYAAAAASUVORK5CYII=", "base64");
  const preview = { view: "preview", game: "gi", path: "角色/001.png", version: "52" };
  const browse = { view: "browse", game: "gi" };
  try {
    for (let index = 1; index <= 13; index++) {
      await add(join(gallery, "gi", "角色", `${String(index).padStart(3, "0")}.png`), png);
    }
    await add(join(gallery, "gi", "武器", "青.png"), png);
    await add(join(gallery, "gi", "bad.png"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(50_000, 16);
    oversized.writeUInt32BE(50_000, 20);
    await add(join(gallery, "gi", "oversized.png"), oversized);
    await add(join(gallery, "zzz", "next.png"), png);
    await add(join(version, "gallery", "gi", "角色", "001.png"), "old duplicate");
    await add(join(version, "gallery", "gi", "old-layout.png"), png);
    const outside = join(directory, "private.png");
    await add(outside, png);
    await symlink(outside, join(gallery, "gi", "linked.png"));
    await symlink("snapshots/52/data", join(atlas, "current"));

    expect((await api(new Request(`http://panel.local${endpoint}?${new URLSearchParams(preview)}`)))?.status).toBe(401);
    expect((await request({ ...browse, game: "bh3" }))?.status).toBe(400);
    expect((await request({ ...browse, page: "-1" }))?.status).toBe(400);
    expect(await (await request({ ...browse, q: "００１" }))?.json()).toEqual({
      version: 52, folders: ["角色", "武器"], page: 1, pages: 1, total: 1,
      items: [{ path: "角色/001.png", bytes: png.length }],
    });
    expect(await (await request({ ...browse, folder: "角色", page: "2" }))?.json()).toEqual({
      version: 52, folders: ["角色", "武器"], page: 2, pages: 2, total: 13,
      items: [{ path: "角色/013.png", bytes: png.length }],
    });
    const thumbnail = await request(preview);
    expect(thumbnail?.status).toBe(200);
    expect(thumbnail?.headers.get("Cache-Control")).toBe("no-store");
    expect(thumbnail?.headers.get("Content-Type")).toBe("image/png");
    const bytes = Buffer.from(await thumbnail!.arrayBuffer());
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([2, 3]);
    expect((await request({ ...preview, path: "old-layout.png" }))?.status).toBe(200);
    expect((await request({ ...preview, path: "linked.png" }))?.status).toBe(404);
    expect((await request({ ...preview, path: "../../private.png" }))?.status).toBe(400);
    expect((await request({ ...preview, path: "bad.png" }))?.status).toBe(422);
    expect((await request({ ...preview, path: "oversized.png" }))?.status).toBe(422);
    expect((await request({ ...preview, path: "next.png" }))?.status).toBe(404);

    let authorizationChecks = 0;
    const revoked = await inventory(new Request(`http://panel.local${endpoint}?${new URLSearchParams(preview)}`),
      () => ++authorizationChecks === 1);
    expect(revoked.status).toBe(401);
    await add(join(atlas, "snapshots", "53", "data", "gallery", "gi", "角色", "001.png"), png);
    await symlink("snapshots/53/data", join(atlas, ".next"));
    await rename(join(atlas, ".next"), join(atlas, "current"));
    expect((await request(preview))?.status).toBe(409);
    expect((await request({ ...preview, version: "53" }))?.status).toBe(200);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
