import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activateUpdate, previousUpdateDirectory } from "../lib/update-activation.ts";
import { readUpdateRuntimePaths, verifyMovedRuntimePaths } from "../lib/update-runtime-paths.ts";
import { readLikeSettings } from "../plugins/group/like-settings.ts";

test("受管切换按 Bun 的显式路径移动独立图鉴和档案，失败后还原", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-update-runtime-"));
  const active = join(dir, "active");
  const candidate = join(dir, "candidate");
  try {
    for (const path of [active, candidate, join(active, "custom"), join(active, "skin", "theme"), join(active, "skin", "fonts"), join(active, "profiles"), join(dir, "outside")]) {
      await mkdir(path, { recursive: true });
    }
    await writeFile(join(active, ".env"), "LOTUS_ATLAS_DATA_DIR=custom\nLOTUS_ATLAS_THEME_DIR=custom/theme\nLOTUS_PROFILE_DIR=ignored\n");
    await writeFile(join(active, "skin", "fonts", "MiSans-VF.ttf"), "fixture adjacent font");
    await writeFile(join(active, "profiles", "42.yaml"), "profile: {id: 1}\n");
    const moduleUrl = new URL("../lib/update-runtime-paths.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import { readUpdateRuntimePaths } from ${JSON.stringify(moduleUrl)}
      console.log(JSON.stringify(await readUpdateRuntimePaths(process.cwd(), AbortSignal.timeout(2000), {
        PATH: process.env.PATH, LOTUS_PROFILE_DIR: "profiles", LOTUS_ATLAS_THEME_DIR: "skin/theme",
      })))
    `], {
      cwd: active, stdout: "pipe", env: { PATH: process.env.PATH, LOTUS_PROFILE_DIR: join(active, "profiles") },
    });
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exit).toBe(0);
    const paths = JSON.parse(stdout);
    expect(paths).toEqual(["custom", "profiles", "skin/fonts/MiSans-VF.ttf", "skin/theme"]);
    const env = {
      LOTUS_ATLAS_DATA_DIR: join(active, "custom"),
      LOTUS_ATLAS_THEME_DIR: join(dir, "outside"),
      LOTUS_PROFILE_DIR: join(active, "profiles"),
    };
    const aborted = activateUpdate(active, candidate, async root => {
      expect(await readFile(join(root, "profiles", "42.yaml"), "utf8")).toBe("profile: {id: 1}\n");
      expect(await readFile(join(root, "skin", "fonts", "MiSans-VF.ttf"), "utf8")).toBe("fixture adjacent font");
      throw new Error("拒绝候选");
    }, paths);
    await expect(aborted).rejects.toThrow("拒绝候选");
    expect(await readFile(join(active, "profiles", "42.yaml"), "utf8")).toBe("profile: {id: 1}\n");
    await expect(verifyMovedRuntimePaths(active, active, env)).rejects.toThrow("仍留在旧版本");
    await expect(verifyMovedRuntimePaths(active, candidate, env)).resolves.toBeUndefined();

    await mkdir(join(candidate, "profiles"));
    await expect(activateUpdate(active, candidate, async () => {}, paths)).rejects.toThrow("占用了持久状态");
    await rm(join(candidate, "profiles"), { recursive: true });
    await symlink(join(dir, "outside"), join(active, "redirect"));
    await expect(activateUpdate(active, candidate, async () => {}, ["redirect/subdir"])).rejects.toThrow("非实体目录");
    expect(await readFile(join(active, "profiles", "42.yaml"), "utf8")).toBe("profile: {id: 1}\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("可写应用覆盖随宿主移动，保留原路径空白和有效 SQLite WAL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-update-writable-"));
  const active = join(dir, "active");
  const candidate = join(dir, "candidate");
  const group = "settings/likes.yaml ";
  const database = "database/catalog.db";
  const settings = {
    LOTUS_GENSHIN_PANEL_DIR: "  custom/genshin-panels  ",
    LOTUS_GENSHIN_PANEL_RANK_DIR: "custom/genshin-panels/ranks",
    LOTUS_GENSHIN_WISH_STATE_DIR: "custom/genshin-wishes",
    LOTUS_STAR_RAIL_WARP_STATE_DIR: "custom/starrail-warps",
    LOTUS_ZZZ_PANEL_DIR: "custom/zzz panels ",
    LOTUS_ZZZ_SHOWCASE_DIR: "data/zzz-showcase",
    LOTUS_GUIDES_ROLE_DIR: " custom/guides ",
    LOTUS_MEME_DB: `./${database}`,
    LOTUS_GROUP_CONFIG: group,
  } as const;
  const state = [
    "custom/genshin-panels/ranks", "custom/genshin-wishes", "custom/starrail-warps",
    "custom/zzz panels ", "custom/guides/add_ons", "data/zzz-showcase",
  ];
  try {
    for (const path of [candidate, ...state.map(path => join(active, path)), join(active, "database"), join(active, "settings")]) {
      await mkdir(path, { recursive: true });
    }
    await Promise.all(state.map(path => writeFile(join(active, path, "fixture"), path)));
    await writeFile(join(active, ".env"), Object.entries(settings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`).join(""));
    await writeFile(join(active, group), "enable: true\ncount: 7\n");

    // A separate SQLite process leaves a real committed but uncheckpointed transaction on exit.
    const writer = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(database)});
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE saved (value TEXT);");
      db.query("INSERT INTO saved VALUES (?)").run("fixture retained in WAL");
      process.kill(process.pid, "SIGKILL");
    `], { cwd: active, env: { PATH: process.env.PATH }, stdout: "ignore", stderr: "ignore" });
    expect(await writer.exited).not.toBe(0);
    expect((await Bun.file(join(active, database + "-wal")).stat()).size).toBeGreaterThan(32);
    expect(await Bun.file(join(active, database + "-shm")).exists()).toBe(true);
    expect(await Bun.file(join(active, database + "-journal")).exists()).toBe(false);

    const paths = await readUpdateRuntimePaths(active, AbortSignal.timeout(2_000), { PATH: process.env.PATH });
    expect(paths).toEqual([
      "custom/genshin-panels", "custom/genshin-wishes", "custom/guides", "custom/starrail-warps",
      "custom/zzz panels ", database, database + "-shm", database + "-wal", group,
    ]);
    await mkdir(join(candidate, "database"));
    const conflict = join(candidate, database + "-wal");
    await writeFile(conflict, "candidate collision");
    await expect(activateUpdate(active, candidate, async () => {}, paths)).rejects.toThrow("占用了持久状态");
    expect(await readFile(conflict, "utf8")).toBe("candidate collision");
    expect((await readLikeSettings({ file: join(active, group) })).settings.count).toBe(7);
    await rm(conflict);

    const activated = await activateUpdate(active, candidate, async (root) => {
      for (const path of state) expect(await readFile(join(root, path, "fixture"), "utf8")).toBe(path);
      expect((await readLikeSettings({ file: join(root, group) })).settings).toMatchObject({ enable: true, count: 7 });
      expect(await Bun.file(join(root, database + "-wal")).exists()).toBe(true);
      expect(await Bun.file(join(root, database + "-shm")).exists()).toBe(true);
      const db = new Database(join(root, database), { readonly: true });
      try {
        expect(db.query("SELECT value FROM saved").get()).toEqual({ value: "fixture retained in WAL" });
      } finally {
        db.close();
      }
    }, paths);
    await expect(verifyMovedRuntimePaths(active, activated.previous, settings)).resolves.toBeUndefined();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("受管更新保留图鉴供体、三游戏原图及登录和便笺固定素材", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-update-artwork-"));
  const active = join(dir, "active");
  const candidate = join(dir, "candidate");
  const settings = {
    LOTUS_ATLAS_THEME_SOURCE_DIR: " theme/donor ",
    LOTUS_CHARACTER_GALLERY_DIR: " media/gallery",
    LOTUS_PASSPORT_QR_RESOURCES: " resources/login",
    LOTUS_DAILY_NOTE_RESOURCES: " resources/note",
  };
  const selected = [
    "theme/donor/bg/bg-pyro.webp", "theme/donor/common/bg/bg-sr.webp", "theme/donor/common/cont/card-bg.png",
    "theme/donor/common/font/HYWH-65W.ttf", "theme/donor/portraits/index.json", "theme/donor/portraits/gi-10000003.webp",
    "theme/donor/meta-gs/character/空/imgs/splash.webp", "theme/fonts/MiSans-VF.ttf",
    "media/gallery/gs-character/角色.webp", "media/gallery/sr-character/开拓者/原图.png",
    "media/gallery/zzz-character/安比/a.webp", " media/gallery/zzz-character/安比/b.webp",
    "resources/login/miao-theme/bg/bg-hydro.webp", "resources/login/source-templates/miao-stat/fonts/NZBZ.ttf",
    " resources/login/source-templates/miao/common/theme/main-01.png",
    " resources/login/source-templates/miao-stat/fonts/NZBZ.ttf",
    " resources/login/source-templates/miao-stat/fonts/tttgbnumber.ttf", " resources/login/miao-theme/bg/bg-hydro.webp",
    " resources/note/miao-theme/fonts/HYWH-65W.ttf", " resources/note/fonts/MiSans-VF.ttf",
    " resources/note/source-templates/miao-stat/fonts/tttgbnumber.ttf",
    " resources/note/source-templates/genshin/note-icons/gs/参量质变仪.png",
  ];
  const unrelated = [
    "theme/donor/app.ts", "theme/donor/meta-gs/character/其他角色/imgs/splash.webp",
    "media/gallery/original.psd", " media/gallery/sr-character/仅原样.jpg",
    " resources/login/secret.txt", "resources/login/source-templates/miao/common/theme/bg-01.jpg",
    "resources/note/fonts/MiSans-VF.ttf",
  ];
  const conflict = selected[2]!;
  try {
    await mkdir(candidate);
    await Promise.all([...selected, ...unrelated].map(async (path) => {
      const file = join(active, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, path);
    }));
    await writeFile(join(active, ".env"), Object.entries(settings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`).join(""));
    const getPaths = (env: NodeJS.ProcessEnv = {}) =>
      readUpdateRuntimePaths(active, AbortSignal.timeout(3_000), { PATH: process.env.PATH, ...env });
    const paths = await getPaths();
    expect(paths).toEqual(expect.arrayContaining([
      "theme/donor/portraits", "media/gallery/gs-character", "media/gallery/sr-character",
      "media/gallery/zzz-character", " media/gallery/zzz-character",
    ]));
    const explicitTheme = await getPaths({ LOTUS_ATLAS_THEME_DIR: "verified-theme" });
    expect(explicitTheme).toEqual(paths.filter(path => !path.startsWith("theme/")));
    await expect(verifyMovedRuntimePaths(active, active, settings)).rejects.toThrow("仍留在旧版本");

    await mkdir(dirname(join(candidate, conflict)), { recursive: true });
    await writeFile(join(candidate, conflict), "candidate");
    await expect(activateUpdate(active, candidate, async () => {}, paths)).rejects.toThrow("占用了持久状态");
    expect(await readFile(join(active, conflict), "utf8")).toBe(conflict);
    expect(await readFile(join(candidate, conflict), "utf8")).toBe("candidate");
    await rm(join(candidate, conflict));

    const result = await activateUpdate(active, candidate, async root => {
      for (const file of selected) expect(await readFile(join(root, file), "utf8")).toBe(file);
      for (const file of unrelated) expect(await Bun.file(join(root, file)).exists()).toBe(false);
    }, paths);
    for (const file of unrelated) expect(await readFile(join(result.previous, file), "utf8")).toBe(file);
    await expect(verifyMovedRuntimePaths(active, result.previous, settings)).resolves.toBeUndefined();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("候选拒绝旧主管遗留的相对图库链接，即使图已随 data 移走", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-archive-gallery-"));
  const active = join(dir, "active");
  const candidate = join(dir, "candidate");
  const picture = "sr-character/角色.webp";
  const env = { PATH: process.env.PATH, LOTUS_CHARACTER_GALLERY_DIR: "custom-gallery" };
  const verify = async (root: string) => {
    const previous = await previousUpdateDirectory(root);
    if (!previous) throw new Error("测试候选缺少旧目录记录。");
    await verifyMovedRuntimePaths(root, previous, env);
    expect(await readFile(join(root, "custom-gallery", picture), "utf8")).toBe("原图字节");
  };
  try {
    await mkdir(join(active, "data/gallery/sr-character"), { recursive: true });
    await mkdir(candidate);
    await writeFile(join(active, "data/gallery", picture), "原图字节");
    await symlink("data/gallery", join(active, "custom-gallery"));

    await expect(activateUpdate(active, candidate, verify)).rejects.toThrow("仍留在旧版本");
    expect(await readFile(join(active, "custom-gallery", picture), "utf8")).toBe("原图字节");

    const state = await readUpdateRuntimePaths(active, AbortSignal.timeout(3_000), env);
    expect(state).toEqual(["custom-gallery"]);
    await activateUpdate(active, candidate, verify, state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("共享图库保留外置链接，指向未保护的安装内路径时拒绝切换", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-update-gallery-link-"));
  const active = join(dir, "active");
  const candidate = join(dir, "candidate");
  const outside = join(dir, "outside");
  try {
    await Promise.all([mkdir(active), mkdir(candidate), mkdir(join(outside, "gs-character"), { recursive: true })]);
    await writeFile(join(outside, "gs-character", "角色.webp"), "outside");
    const env = { LOTUS_CHARACTER_GALLERY_DIR: "gallery", PATH: process.env.PATH };
    const getPaths = () => readUpdateRuntimePaths(active, AbortSignal.timeout(3_000), env);
    await symlink("../outside", join(active, "gallery"));
    expect(await getPaths()).toEqual(["gallery"]);
    const result = await activateUpdate(active, candidate, async root => {
      expect(await readFile(join(root, "gallery", "gs-character", "角色.webp"), "utf8")).toBe("outside");
    }, await getPaths());
    await expect(verifyMovedRuntimePaths(active, result.previous, env)).resolves.toBeUndefined();
    await rm(join(active, "gallery"));
    await mkdir(join(active, "custom-link-target", "gs-character"), { recursive: true });
    await symlink("custom-link-target", join(active, "gallery"));
    await expect(getPaths()).rejects.toThrow("经过指向安装目录内的链接");
    await rm(join(active, "gallery"));
    await mkdir(join(active, "data", "gallery", "gs-character"), { recursive: true });
    await symlink("data/gallery", join(active, "gallery"));
    expect(await getPaths()).toEqual(["gallery"]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
