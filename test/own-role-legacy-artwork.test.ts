import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { createOwnRoleLegacyArtwork } from "../lib/own-role-legacy-artwork.ts";
import { lockFile } from "../lib/file-lock.ts";

const genshinUid = "100000271", starRailUid = "800000271";
const assets = new URL("../packages/skia/resources/uid-list/", import.meta.url);

test("只为本人现登录档案恢复旧 Player 头像和横图，严格隔离星铁首角色、已删和伪造本地资源", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-uid-player-art-"));
  const paths = {
    LOTUS_GENSHIN_PANEL_THEME_DIR: "theme", LOTUS_STAR_RAIL_PANEL_THEME_DIR: "theme",
    LOTUS_GENSHIN_LEGACY_PANEL_DIR: "legacy-gs", LOTUS_STAR_RAIL_LEGACY_PANEL_DIR: "legacy-sr",
    LOTUS_GENSHIN_PANEL_DIR: "native-gs",
  };
  const prior = new Map<string, string | undefined>();
  const profilesDir = join(root, "profiles");
  try {
    for (const [key, subdir] of Object.entries(paths)) {
      prior.set(key, Bun.env[key]);
      Bun.env[key] = join(root, subdir);
      await mkdir(join(root, subdir), { recursive: true });
    }
    const write = async (name: string, value: string | Uint8Array) => {
      const file = join(root, name);
      await mkdir(dirname(file), { recursive: true });
      await Bun.write(file, value);
    };
    const face = new Uint8Array(await Bun.file(new URL("face.webp", assets)).arrayBuffer());
    const check = new Uint8Array(await Bun.file(new URL("check.webp", assets)).arrayBuffer());
    const banner = new Uint8Array(await Bun.file(new URL("zzz-banner.png", assets)).arrayBuffer());
    await write("theme/meta-gs/character/data.json", JSON.stringify({
      10000002: { name: "神里绫华" }, 10000046: { name: "胡桃", elem: "pyro" },
    }));
    await write("theme/meta-sr/character/data.json", JSON.stringify({
      1005: { name: "卡芙卡" }, 1102: { name: "希儿" },
    }));
    const gsBase = "theme/meta-gs/character", srBase = "theme/meta-sr/character";
    await write(`${gsBase}/胡桃/imgs/face.webp`, face);
    await write(`${gsBase}/胡桃/imgs/banner.webp`, banner);
    await write(`${gsBase}/神里绫华/imgs/face.webp`, check);
    await write(`${gsBase}/common/imgs/banner.webp`, check);
    await write(`${srBase}/卡芙卡/imgs/face.webp`, check);
    await write(`${srBase}/common/imgs/banner.webp`, banner);
    const playerFile = `legacy-gs/${genshinUid}.json`;
    const avatars = { 10000002: { id: 10000002 }, 10000046: { id: 10000046 } };
    await write(playerFile, JSON.stringify({ uid: genshinUid, face: "10000046", avatars }));
    await write(`legacy-sr/${starRailUid}.json`, JSON.stringify({
      uid: starRailUid, face: "1102", avatars: [{ id: 1102 }, { id: 1005 }],
    }));
    await write("profiles/42-2.yaml", Bun.YAML.stringify({ user: { qq: "42" }, profile: { id: 2 }, account: {
      stuid: "7242", stoken: "fixture-stoken", cookie: "account_id=7242; ltoken=fixture-cookie",
      game_roles: { gs: [{ uid: genshinUid }], sr: [{ uid: starRailUid }] },
    } }));
    const profiles = createProfileStore(profilesDir);
    const signal = new AbortController().signal;
    const read = createOwnRoleLegacyArtwork(profiles, lockFile);
    const own = await read("42", 2, "gs", genshinUid, signal);
    expect(own).toEqual({ image: Buffer.from(face), banner: Buffer.from(banner) });
    expect(await read("42", 2, "sr", starRailUid, signal)).toEqual({ image: Buffer.from(check), banner: Buffer.from(banner) });
    expect(await read("43", 2, "gs", genshinUid, signal)).toBeUndefined();
    expect(await read("42", 2, "gs", genshinUid, AbortSignal.abort())).toBeUndefined();

    await write(playerFile, JSON.stringify({ uid: "100000999", face: 10000046, avatars }));
    expect(await read("42", 2, "gs", genshinUid, signal)).toBeUndefined();
    await write(playerFile, JSON.stringify({ uid: genshinUid, face: "../unknown", avatars }));
    expect(await read("42", 2, "gs", genshinUid, signal)).toEqual({ image: Buffer.from(check), banner: Buffer.from(check) });
    const replaced = join(root, gsBase, "胡桃/imgs/face.webp");
    await rm(replaced);
    await symlink(new URL("face.webp", assets).pathname, replaced);
    await write(playerFile, JSON.stringify({ uid: genshinUid, face: 10000046, avatars }));
    expect(await read("42", 2, "gs", genshinUid, signal)).toEqual({ image: undefined, banner: Buffer.from(banner) });
    await rm(replaced);
    await write(`${gsBase}/胡桃/imgs/face.webp`, face);
    expect(await read("42", 2, "gs", genshinUid, signal)).toEqual({ image: Buffer.from(face), banner: Buffer.from(banner) });
    await write(`native-gs/42/${genshinUid}.json`, JSON.stringify({ uid: genshinUid, avatars: {}, panelDiscardedAt: Date.now() }));
    expect(await read("42", 2, "gs", genshinUid, signal)).toBeUndefined();
    await profiles.clearLogin("42", 2);
    expect(await read("42", 2, "sr", starRailUid, signal)).toBeUndefined();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
