import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gachaPortraitCharacter, readGachaPlayerArt } from "./player-art.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2eGsQAAAAASUVORK5CYII=", "base64");

const characters = [
  { id: 10000014, name: "芭芭拉" },
  { id: 10000073, name: "纳西妲", abbr: "小草神" },
  { id: 10000046, name: "胡桃", abbr: "小草神" },
];

test("抽卡头像从本人明确选择的角色取头像和横幅，并让缺图走旧候补", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-gacha-player-art-"));
  try {
    const prefix = ["meta-gs", "character"] as const;
    async function image(name: string, ...files: string[]) {
      const folder = join(root, ...prefix, name, "imgs");
      await mkdir(folder, { recursive: true });
      for (const file of files) await writeFile(join(folder, file), png);
      return folder;
    }
    const selected = await image("纳西妲", "face-q.webp", "face.webp", "banner.webp");
    await image("芭芭拉", "face.webp", "banner.webp");
    const outside = await mkdtemp(join(tmpdir(), "lotus-gacha-outside-"));
    try {
      const copy = join(outside, "banner.webp");
      await writeFile(copy, png);
      await symlink(copy, join(await image("胡桃", "face.webp"), "banner.webp"));
      expect(gachaPortraitCharacter(characters, 10000073)).toBe("纳西妲");
      expect(gachaPortraitCharacter(characters, "纳西妲")).toBe("纳西妲");
      expect(gachaPortraitCharacter(characters, "小草神")).toBeUndefined();
      const gs = await readGachaPlayerArt(root, "gs", "本人", "纳西妲");
      expect(gs.face).toEqual({ name: "本人", face: "/meta-gs/character/纳西妲/imgs/face-q.webp",
        banner: "/meta-gs/character/纳西妲/imgs/banner.webp" });
      await rm(join(selected, "face-q.webp"));
      expect((await readGachaPlayerArt(root, "gs", "本人", "纳西妲")).face)
        .toMatchObject({ face: "/meta-gs/character/纳西妲/imgs/face.webp" });
      expect((await readGachaPlayerArt(root, "gs", "本人", "胡桃")).face)
        .toMatchObject({ face: "/meta-gs/character/胡桃/imgs/face.webp", banner: undefined });
      expect((await readGachaPlayerArt(root, "gs", "本人", "../纳西妲")).face)
        .toMatchObject({ face: "/meta-gs/character/芭芭拉/imgs/face.webp" });
      const official = "https://act-webstatic.mihoyo.com/gacha-fixture.png";
      const previousFetch = globalThis.fetch;
      const requested: string[] = [];
      globalThis.fetch = Object.assign(async (url: Request | URL | string) => {
        requested.push(String(url));
        return new Response(png, { headers: { "Content-Type": "image/png" } });
      }, { preconnect: previousFetch.preconnect });
      try {
        const local = await readGachaPlayerArt(root, "gs", "本人", undefined, official);
        expect(local.face.face).toBe("/meta-gs/character/芭芭拉/imgs/face.webp");
        expect(requested).toEqual([]);
        await rm(join(root, ...prefix, "芭芭拉", "imgs", "face.webp"));
        const fallback = await readGachaPlayerArt(root, "gs", "本人", undefined, official);
        expect(fallback.face).toEqual({ name: "本人" });
        expect(fallback.avatar).toEqual(png);
        expect(requested).toEqual([official]);
      } finally {
        globalThis.fetch = previousFetch;
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
