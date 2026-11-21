import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "../packages/account/index.ts";
import { lockFile } from "../lib/file-lock.ts";
import { createModule } from "../plugins/genshin/index.ts";
import { createGenshinPanelArchive, createGenshinPanelQuery } from "../plugins/genshin/panel/panel.ts";
import { artifactProperties, matchGenshinPanel, officialPanel, readPanel, selectAvatar } from "../plugins/genshin/panel/model.ts";

const uid = "100123456";
const role = { uid, nickname: "", gameBiz: "hk4e_cn", region: "cn_gf01", chosen: true };
const catalog = {
  characters: { "10000089": { name: "芙宁娜", abbr: "芙芙", star: 5, elem: "hydro", talentId: { 10892: "e" }, talentCons: { e: 5 } } },
  artifacts: new Map([[78543, { name: "旅途中的鲜花", set: "黄金剧团" }]]),
  artifactSets: new Map([["旅途中的鲜花", "黄金剧团"]]),
};
const avatar = {
  base: { id: 10000089, name: "芙宁娜", level: 90, element: "Hydro", actived_constellation_num: 5, fetter: 10 },
  weapon: { name: "静水流涌之辉", level: 90, promote_level: 6, affix_level: 2 },
  skills: [{ skill_id: 10891, skill_type: 1, level: 9 }, { skill_id: 10892, skill_type: 1, level: 13 }],
  selected_properties: [{ property_type: 2000, final: "38,391", base: "16395", bonus: "21996" }, { property_type: 20, value: "74.2%" }],
  relics: [{
    id: 78543, pos: 1, rarity: 5, level: 20,
    main_property: { property_type: 2, value: "4780" },
    sub_property_list: [{ property_type: 22, value: "15.5%", times: 1 }, { property_type: 20, value: "3.9%", times: 0 }],
  }],
};

const legacy = {
  uid: Number(uid), _profile: 1000,
  avatars: { "10000002": { id: 10000002, name: "神里绫华", level: 90, elem: "cryo", cons: 0, _source: "enka",
    weapon: { name: "雾切之回光", level: 90, affix: 1 }, talent: { a: 9, e: 9, q: 10 },
    artis: { 1: { name: "历经风雪的思念", level: 20, star: 5, mainId: 14001, attrIds: ["501224", "501204"] } },
  } },
};

test("原神旧面板入口支持档案、UID 及角色别称，避开其他游戏和计算命令", () => {
  expect(matchGenshinPanel("#更新面板2")).toEqual({ type: "update", profileId: 2 });
  expect(matchGenshinPanel("#米游社原神面板更新")).toEqual({ type: "update", profileId: 1 });
  expect(matchGenshinPanel("#原神角色面板100123456")).toEqual({ type: "list", profileId: 1, uid });
  expect(matchGenshinPanel("#芙芙圣遗物2")).toEqual({ type: "detail", mode: "artifacts", name: "芙芙", profileId: 2 });
  expect(matchGenshinPanel("#行秋面板")?.name).toBe("行秋");
  expect(matchGenshinPanel("#重云详情")?.name).toBe("重云");
  for (const value of ["#星铁面板", "#原神更新面板999", "#芙宁娜图鉴", "#绝区零角色面板", "#删除面板"]) {
    expect(matchGenshinPanel(value)).toBeUndefined();
  }
  expect(selectAvatar(officialPanel(uid, [avatar], catalog, 10), "水神", catalog)?.id).toBe(10000089);
});

test("米游社数值保留真实值和旧 Miao 字段，旧圣遗物词条按旧表解析", () => {
  const data = officialPanel(uid, [avatar], catalog, 3000);
  const furina = data.avatars["10000089"]!;
  expect(furina).toMatchObject({
    id: 10000089, elem: "hydro", cons: 5, fetter: 10, talent: { a: 9, e: 10 }, _source: "mysPanel",
    weapon: { name: "静水流涌之辉", level: 90, promote: 6, affix: 2 },
    _lotus: { properties: [
      { key: "hp", value: "38391", base: "16395", plus: "21996" }, { key: "cpct", value: "74.2%" },
    ] },
    artis: { 1: { mainId: 14001, attrIds: ["501224", "501224", "501204"] } },
  });
  expect(artifactProperties(furina.artis["1"]!)).toMatchObject([
    { key: "hpPlus", value: "4780" }, { key: "cdmg", value: "15.5%" }, { key: "cpct", value: "3.9%" },
  ]);
  const old = readPanel(uid, legacy, catalog, true);
  expect(old?.avatars["10000002"]?.talent.q).toBe(10);
  expect(artifactProperties(old!.avatars["10000002"]!.artis["1"]!)).toContainEqual({ key: "cdmg", value: "7.8%" });
  expect(() => readPanel("100999999", legacy, catalog, true)).toThrow();
  expect(() => officialPanel(uid, [avatar, avatar], catalog, 3000)).toThrow();
});

test("按已绑角色读旧面板，更新合并现有记录，档案切换终止写入并阻止重复刷新", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-genshin-panel-"));
  const legacyDirectory = join(root, "legacy");
  const archiveDirectory = join(root, "archive");
  let change: Promise<void> | undefined;
  let revision = "r1";
  let calls = 0;
  let rows: readonly typeof avatar[] = [avatar];
  const png = Buffer.from("fixture-only");
  const report = { png };
  try {
    await mkdir(legacyDirectory);
    const original = JSON.stringify(legacy);
    await writeFile(join(legacyDirectory, `${uid}.json`), original);
    const query = createGenshinPanelQuery({
      async savedRole() { return { ...role, uid: "100999999" }; },
      async requestContext(qq, profileId, game) { return { qq, profileId, game, role, revision } as ProfileRequestContext; },
    }, {
      async fetchGenshinPanel(source) {
        calls++;
        expect(source.role.uid).toBe(uid);
        expect(source.profileId).toBe(2);
        const seen = revision;
        await change;
        return { avatars: rows, revision: seen };
      },
    }, lockFile, new AbortController().signal, {
      archiveDirectory, legacyDirectory, now: () => 3000,
      theme: async () => ({ ...catalog, async picture() { return undefined; } }),
      render: {
        async list(data, list) {
          expect(data.uid).toBe(uid);
          expect(list.map(row => row.name)).toContain("神里绫华");
          return report;
        },
        async detail(_data, row, _theme, options) {
          expect(row.weapon?.name).toBe("静水流涌之辉");
          expect(options?.pane).toBe("artifacts");
          return report;
        },
      },
    });
    expect(await query("#面板2", { user_id: 42 })).toEqual({ type: "image", file: png });
    expect(await query("#面板100999999", { user_id: 42 })).toContain("UID 与当前档案绑定");
    expect(calls).toBe(0);
    expect(await query("#更新面板2", { user_id: 42 })).toEqual({ type: "image", file: png });
    expect(await query("#芙芙圣遗物2", { user_id: 42 })).toEqual({ type: "image", file: png });
    expect(calls).toBe(1);
    const savedPath = join(archiveDirectory, "42", `${uid}.json`);
    const before = await readFile(savedPath, "utf8");
    expect(Object.keys(JSON.parse(before).avatars)).toEqual(["10000002", "10000089"]);
    expect(await readFile(join(legacyDirectory, `${uid}.json`), "utf8")).toBe(original);

    const inFlight = Promise.withResolvers<void>();
    change = inFlight.promise;
    const first = query("#更新面板2", { user_id: 42 });
    for (let i = 0; calls < 2 && i < 30; i++) await Bun.sleep(10);
    expect(await query("#更新面板2", { user_id: 42 })).toContain("正在更新");
    revision = "changed";
    inFlight.resolve();
    expect(await first).toContain("档案已变化");
    expect(await readFile(savedPath, "utf8")).toBe(before);
    rows = [];
    expect(await query("#更新面板2", { user_id: 42 })).toContain("原档案已保留");
    expect(await readFile(savedPath, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("原神背包、世界 BOSS 与抽卡档案的群开关各按本功能指令生效", () => {
  const controller = new AbortController();
  const module = createModule({ signal: controller.signal, lockFile });
  try {
    const attachment = { name: "UIGF.json", async read() { return undefined; } };
    const context = (normalizedMessage: string) => ({ normalizedMessage, reply() {} });
    const gachaFeature = ["[gacha] 抽卡记录"];
    for (const raw of ["#抽卡记录2", "#更新抽卡记录", "#强制导出记录", "#同步外部抽卡记录", "#同步外部抽卡记录2", "#抽卡帮助", "#导入记录"]) {
      expect(module.fallbackFeatures(context(raw))).toEqual(gachaFeature);
    }
    for (const raw of ["#原神背包", "#原神背包2"]) {
      expect(module.fallbackFeatures(context(raw))).toEqual(["[genshin] 背包"]);
    }
    for (const raw of ["#世界BOSS击杀", "#BOSS击杀", "#原神世界boss击杀2", "#原神世界Boss击杀排行", "#boss击杀排行"]) {
      expect(module.fallbackFeatures(context(raw))).toEqual(["[genshin] 世界 BOSS"]);
    }
    for (const raw of ["#面板", "#更新面板2", "#芙宁娜面板", "#武器十连", "#原神养成计算 芙宁娜",
      "#原神练度统计", "#天赋统计", "#芙宁娜排行", "#背包", "#世界boss", "#星铁BOSS击杀", "#更新小助手抽卡记录"]) {
      expect(module.fallbackFeatures(context(raw))).toEqual([]);
    }
    expect(module.fallbackFeatures({ ...context(""), attachment })).toEqual(gachaFeature);
    expect(module.fallbackFeatures({ ...context(""), attachment: { ...attachment, name: "表情.png" } })).toEqual([]);
  } finally {
    controller.abort();
  }
});

test("删除原神面板在本人档案内确认 UID，阻止在途更新和旧共享缓存复活", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-gs-panel-discard-"));
  const legacyDirectory = join(root, "legacy");
  const archiveDirectory = join(root, "archive");
  const profiles = join(root, "profiles");
  const otherUid = "100123457";
  const deniedUid = "100123458";
  const contents = JSON.stringify(legacy);
  const qq = "42";
  const messageContext = { user_id: Number(qq), message_type: "group" };
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let now = 3000;
  let calls = 0;
  try {
    await Promise.all([mkdir(legacyDirectory), mkdir(profiles)]);
    await writeFile(join(legacyDirectory, `${uid}.json`), contents);
    const profile = (user: string, id: number, current = otherUid,
      roles = [uid, otherUid]) => Bun.YAML.stringify({ user: { qq: user }, profile: { id }, account: {
        cookie: "account_id=900000002;cookie_token=fixture;ltuid=900000002;ltoken=fixture",
        stuid: "900000002", stoken: "fixture", current_uid: { gs: current },
        game_roles: { gs: roles.map(uid => ({ uid, region: "cn_gf01", game_biz: "hk4e_cn" })) },
      } });
    await writeFile(join(profiles, "42-2.yaml"), profile(qq, 2));
    await writeFile(join(profiles, "43-2.yaml"), profile("43", 2));
    await writeFile(join(profiles, "44.yaml"), profile("44", 1, uid, []));
    const profileStore = createProfileStore(profiles);
    const archive = createGenshinPanelArchive(lockFile, { archiveDirectory, legacyDirectory });
    const query = createGenshinPanelQuery(profileStore, {
      async fetchGenshinPanel(source) {
        if (++calls === 1) {
          started.resolve();
          await release.promise;
        }
        return { avatars: [avatar], revision: source.revision };
      },
    }, lockFile, new AbortController().signal, {
      archiveDirectory, legacyDirectory, now: () => now,
      theme: async () => ({ ...catalog, async picture() { return undefined; } }),
      render: { async list() { return { png: Buffer.from("fixture") }; }, async detail() { throw new Error("unexpected"); } },
    });
    const own = { ...messageContext, message_type: "private" };
    expect(await query("#删除面板2", messageContext)).toContain(`#删除面板${otherUid} 档案2`);
    expect(await query(`#原神删除全部面板${uid} 档案2`, { ...own, isDelegated: true })).toContain("本人 QQ");
    expect(await query(`#原神删除面板${deniedUid} 档案2`, own)).toContain("已同步");
    expect(await query(`#删除面板${uid}`, { ...own, user_id: 44 })).toContain("已同步");
    expect(await archive.discardedAt(qq, uid)).toBe(0);
    await writeFile(join(profiles, "42-2.yaml"), profile(qq, 2, uid));
    expect(await archive.readPanel(qq, uid, catalog)).toBeDefined();
    const refresh = query("#更新面板2", messageContext);
    await Promise.race([started.promise, refresh.then(reply => { throw new Error(String(reply)); })]);
    now++;
    expect(await query(`#原神删除面板数据${uid} 档案2`, messageContext)).toContain("本地面板已删除");
    release.resolve();
    expect(await refresh).toContain("重新发起更新");
    expect(await query("#面板2", own)).toContain("本地暂无原神角色面板");
    expect(await archive.readPanel("43", uid, catalog)).toBeDefined();
    expect(await readFile(join(legacyDirectory, `${uid}.json`), "utf8")).toBe(contents);

    now++;
    expect(await query("#更新面板2", messageContext)).toMatchObject({ type: "image" });
    expect(Object.keys((await archive.readPanel(qq, uid, catalog))!.avatars)).toEqual(["10000089"]);
    expect(await archive.discardedAt(qq, uid)).toBe(3001);
    now++;
    await expect(query(`#删除面板${uid} 档案2`, own)).resolves.toContain("本地面板已删除");
    expect(await archive.readPanel(qq, uid, catalog)).toBeUndefined();
    expect(await archive.discardedAt(qq, uid)).toBe(3003);
  } finally {
    release.resolve();
    await rm(root, { recursive: true, force: true });
  }
});
