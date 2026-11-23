import { expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { stageLegacyGameData } from "../lib/migration-game-data.ts";
import { panelGenshinGuideSettings, panelGuidesSettings, panelZzzGuideSettings } from "../lib/panel-guides-settings.ts";
import { createGenshinGachaHistoryStore } from "../plugins/genshin/gacha-store.ts";
import { createGenshinPanelArchive } from "../plugins/genshin/panel/panel.ts";
import { createRoleMaterials } from "../plugins/guides/role-materials.ts";
import { readGuideAuthors } from "../plugins/guides/role-guide-collections.ts";
import { createRoleGuides } from "../plugins/guides/role-guides.ts";
import { readLegacyPanel } from "../plugins/starrail/panel-model.ts";
import { readZzzFlatLegacyGacha } from "../plugins/zzz/gacha-legacy.ts";

const qq = "42";
const uid = "512345678";
const longId = "9223372036854775807";
const gacha = `data/gachaJson/${qq}/${uid}`;
const gsPanel = `data/PlayerData/gs/${uid}.json`;
const srPanel = `data/PlayerData/sr/${uid}.json`;
const zzzUid = "1300000002";
const zzzGacha = `data/ZZZ-Plugin/gacha/${zzzUid}.json`;

async function put(root: string, path: string, data: string | Buffer) {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, data);
}

async function fixture(check: (source: string, state: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "lotus-migration-games-"));
  const source = join(parent, "old");
  const state = join(parent, "state");
  try {
    await Promise.all([mkdir(source), mkdir(state, { mode: 0o700 })]);
    await check(source, state);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("发布到游戏目前读取的旧目录，长记录编号和原 JSON 保持完全相同", () => fixture(async (source, state) => {
  const gachaPool = [{ uid, id: longId, gacha_type: "301" }];
  const zzzRecord = { uid: zzzUid, id: longId, gacha_id: "751403", gacha_type: "2001", item_id: "14101", count: "1",
    time: "2025-03-09 02:30:00", name: "测试频段", lang: "zh-cn", item_type: "代理人", rank_type: "4" };
  const data = {
    [`${gacha}/301.json`]: `${JSON.stringify(gachaPool)}\r\n`,
    [`${gacha}/100.json`]: "[]\n",
    [gsPanel]: JSON.stringify({ uid, avatars: {} }),
    [srPanel]: JSON.stringify({ uid: Number(uid), avatars: {} }),
    [zzzGacha]: JSON.stringify({ 独家频段: [zzzRecord] }),
  };
  for (const [path, content] of Object.entries(data)) await put(source, path, content);

  const exportFile = `${gacha}/12345.json`;
  const longPanel = "data/PlayerData/gs/123456789012345.json";
  const archived = {
    [exportFile]: '{"info":{},"hk4e":[]}',
    [longPanel]: '{"uid":"123456789012345","avatars":{}}',
    [`data/textJson/${qq}.json`]: '{"旧本地数据":[]}',
  };
  for (const [path, content] of Object.entries(archived)) await put(source, path, content);

  const result = await stageLegacyGameData(source, state);
  expect(result.active.map(({ path, files }) => [path, files])).toEqual([
    ["data/gachaJson", 2], ["data/PlayerData/gs", 1], ["data/PlayerData/sr", 1], ["data/ZZZ-Plugin/gacha", 1],
  ]);
  expect(result.archived.map(({ path, files }) => [path, files])).toEqual([
    ["backup/legacy-data/gachaJson", 1], ["backup/legacy-data/PlayerData/gs", 1], ["backup/legacy-data/textJson", 1],
  ]);
  for (const [path, content] of Object.entries(data)) {
    expect(await readFile(join(state, path), "utf8")).toBe(content);
    expect((await lstat(join(state, path))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(source, path), "utf8")).toBe(content);
  }
  for (const [path, content] of Object.entries(archived)) {
    expect(await readFile(join(state, "backup/legacy-data", path.slice(5)), "utf8")).toBe(content);
    expect(await Bun.file(join(state, path)).exists()).toBe(false);
    expect(await readFile(join(source, path), "utf8")).toBe(content);
  }

  const genshin = createGenshinGachaHistoryStore(join(state, "data/gachaJson"), lockFile);
  expect(await genshin.read(qq, uid)).toEqual({ 301: gachaPool });
  expect(await genshin.read("43", uid)).toEqual({});
  expect(await genshin.readBeginner(qq, uid)).toEqual([]);
  const genshinPanel = createGenshinPanelArchive(lockFile, {
    archiveDirectory: join(state, "data/genshin/panels"), legacyDirectory: join(state, "data/PlayerData/gs"),
  });
  expect(await genshinPanel.readLegacy(uid, { characters: {}, artifacts: new Map(), artifactSets: new Map() }))
    .toMatchObject({ uid, avatars: {} });
  expect(readLegacyPanel(uid, await Bun.file(join(state, srPanel)).json())).toMatchObject({ uid, avatars: [] });
  const zzz = await readZzzFlatLegacyGacha([join(state, "data/ZZZ-Plugin/gacha")], zzzUid);
  expect(zzz?.pools.flatMap(pool => pool.records)).toMatchObject([{ id: longId, time: zzzRecord.time }]);
}));

test("复制四个固定素材缓存目录中的原图，迁移后无需访问原站", () => fixture(async (source, state) => {
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
  const paths = ["gs/友人A/刻晴.jpg", "gs/other/纳西妲.jpg", "sr/小橙子啊/符玄.jpg", "sr/other/希儿.jpg"];
  for (const path of paths) await put(source, `temp/material/${path}`, image);
  await put(source, "temp/material/gs/友人A/坏文件.jpg", "not an image");
  await put(source, "temp/material/gs/友人A/无关.txt", "not an image");
  await put(source, "temp/material/zzz/other/艾莲.jpg", image);
  await put(source, "temp/material/gs/自定义/刻晴.jpg", image);
  await symlink(join(source, "temp/material/gs/友人A/刻晴.jpg"), join(source, "temp/material/gs/友人A/链接.jpg"));
  await link(join(source, "temp/material/gs/自定义/刻晴.jpg"), join(source, "temp/material/gs/友人A/硬链接.jpg"));
  expect(await stageLegacyGameData(source, state)).toEqual({ active: [{ path: "data/guides/material", files: paths.length,
    bytes: image.byteLength * paths.length }], archived: [] });
  const directory = join(state, "data/guides/material");
  for (const path of paths) {
    expect(await readFile(join(directory, path))).toEqual(image);
    expect(await readFile(join(source, "temp", "material", path))).toEqual(image);
    expect((await lstat(join(directory, path))).mode & 0o777).toBe(0o600);
  }
  expect(await readdir(join(directory, "gs", "友人A"))).toEqual(["刻晴.jpg"]);
  expect((await readdir(directory)).sort()).toEqual(["gs", "sr"]);
  let requests = 0;
  const command = createRoleMaterials({ cache: directory, async fetch() { requests++; return new Response(null, { status: 404 }); } });
  for (const text of ["#刻晴素材", "#星铁符玄素材"]) expect(await command(text)).toEqual({ type: "image", file: image });
  expect(requests).toBe(0);
}));

test("拒载的旧攻略来源设置转成宿主与面板直接读取的配置", () => fixture(async (source, state) => {
  const paths = {
    "plugins/genshin/config/mys.set.yaml": "defaultSource: 4\nunused: ignored\n",
    "plugins/ZZZ-Plugin/defSet/guide.yaml": "default_guide: 1\nmax_forward_guides: 5\n",
    "plugins/ZZZ-Plugin/config/guide.yaml": "default_guide: all\nmax_forward_guides: -1\n",
    "plugins/mora-plugin/config/default/config.yaml": "forwardMsg: 1\n",
    "plugins/mora-plugin/config/user/config.yaml": "forwardMsg: 0\n",
    "plugins/mora-plugin/config/default/roleGuides.yaml": "news: [{source: 默认作者, collection_id: [31]}]\n",
    "plugins/mora-plugin/config/user/roleGuides.yaml": "news: [{source: 用户作者, collection_id: [32]}]\nolds: []\n",
    "plugins/mora-plugin/config/default/srRoleGuides.yaml": "[{source: 星铁作者, collection_id: [33]}]\n",
    "plugins/mora-plugin/config/user/zzzRoleGuides.yaml": "[]\n",
  };
  for (const [path, value] of Object.entries(paths)) await put(source, path, value);
  const result = await stageLegacyGameData(source, state);
  expect(result.active.map(({ path, files }) => [path, files])).toEqual([["data/guides/roleGuides", 2], ["config", 1]]);
  const root = Bun.pathToFileURL(state + "/");
  const get = async (endpoint: (request: Request, authorized: () => boolean) => Promise<Response>) => {
    const response = await endpoint(new Request("http://localhost/settings"), () => true);
    expect(response.status).toBe(200);
    return (await response.json()).values;
  };
  expect(await get(panelGenshinGuideSettings(root))).toEqual({ defaultSource: 4 });
  expect(await get(panelZzzGuideSettings(root))).toEqual({ default_guide: 0, max_forward_guides: 5 });
  expect(await get(panelGuidesSettings(root))).toMatchObject({
    forward: false,
    gs_collections: { news: [{ source: "用户作者", collection_id: [32] }], olds: [] },
    sr_collections: [{ source: "星铁作者", collection_id: [33] }],
    zzz_collections: [],
  });
  expect(await readGuideAuthors("zzz", undefined, root)).toEqual({ news: [], olds: [] });
  expect(await readGuideAuthors("gs", undefined, root)).toEqual({
    news: [{ source: "用户作者", collection_id: [32] }], olds: [],
  });
  for (const [path, value] of Object.entries(paths)) expect(await readFile(join(source, path), "utf8")).toBe(value);
}));

test("编号攻略保留 temp 优先级和各作者原字节，离线通过实际命令读取", () => fixture(async (source, state) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
  const original = Buffer.concat([png, Buffer.from("temp")]);
  await put(source, "temp/strategy/4/钟离.jpg", original);
  await put(source, "data/strategy/4/钟离.jpg", png);
  await put(source, "data/strategy/3/钟离.jpg", png);
  await put(source, "temp/strategy/3/钟离.jpg", "旧临时文件损坏");
  await put(source, "temp/strategy/8/钟离.jpg", png);
  await stageLegacyGameData(source, state);
  const offline = Object.assign(async () => { throw new Error("不应访问原站"); }, { preconnect: fetch.preconnect });
  const query = createRoleGuides({ cache: join(state, "data/guides/roleGuides"), guideAutomatic: false, fetch: offline,
    legacyStrategies: [join(state, "data/strategy")] });
  expect(await query("#钟离攻略4")).toEqual({ type: "image", file: original });
  expect(await query("#钟离攻略3")).toEqual({ type: "image", file: png });
  expect((await readdir(join(state, "data/strategy"))).sort()).toEqual(["3", "4"]);
  expect(await readFile(join(source, "data/strategy/4/钟离.jpg"))).toEqual(png);
}));

test("普通游戏迁移可跳过符号链接指向的旧临时缓存", () => fixture(async (source, state) => {
  await symlink(state, join(source, "temp"));
  await put(source, gsPanel, JSON.stringify({ uid, avatars: {} }));
  expect((await stageLegacyGameData(source, state)).active.map(({ path }) => path)).toEqual(["data/PlayerData/gs"]);
  expect(await Bun.file(join(state, "data/guides/material/gs/友人A/刻晴.jpg")).exists()).toBe(false);
}));

test("旧数据的文件或目录链接以及目标软链不会产生可加载拷贝", () => fixture(async (source, state) => {
  const pool = join(source, gacha, "301.json");
  await put(source, "source.json", "[]");
  await mkdir(dirname(pool), { recursive: true });
  await symlink(join(source, "source.json"), pool);
  await expect(stageLegacyGameData(source, state)).rejects.toThrow("无硬链接的普通文件");
  await rm(pool);
  await link(join(source, "source.json"), pool);
  await expect(stageLegacyGameData(source, state)).rejects.toThrow("无硬链接的普通文件");
  await rm(pool);
  await rm(dirname(pool), { recursive: true });
  await symlink(state, dirname(pool));
  await expect(stageLegacyGameData(source, state)).rejects.toThrow("副本的实体目录");
  await rm(dirname(pool));
  await put(source, `${gacha}/301.json`, "[]");

  const outside = join(dirname(source), "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(state, "data"));
  await expect(stageLegacyGameData(source, state)).rejects.toThrow("暂存路径须为私有实体目录");
  expect(await readdir(outside)).toEqual([]);
  expect(await readFile(pool, "utf8")).toBe("[]");
}));

test("未完成写入、损坏的活跃卡池和取消需要保留原副本供核对", () => fixture(async (source, state) => {
  const abort = AbortSignal.abort(new Error("取消游戏暂存"));
  await expect(stageLegacyGameData(source, state, abort)).rejects.toThrow("取消游戏暂存");
  const journal = `${gacha}/.lotus-genshin-gacha-journal.json`;
  await put(source, journal, "{}");
  await expect(stageLegacyGameData(source, state)).rejects.toThrow("未恢复的写入");
  expect(await readdir(state)).toEqual([]);
  await rm(join(source, journal));

  const invalid = `${gacha}/301.json`;
  await put(source, invalid, '{"invalid":true}');
  await expect(stageLegacyGameData(source, state)).rejects.toThrow("含无法由当前版本读取的文件");
  expect(await readFile(join(source, invalid), "utf8")).toBe('{"invalid":true}');
}));
