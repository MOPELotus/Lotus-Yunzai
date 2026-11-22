import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
