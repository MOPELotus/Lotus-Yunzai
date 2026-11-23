import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { groupPanelNumber, panelGroupRankSettings, readArtifactListLimit, readGroupPanelRankEnabled, readGroupPanelRankLimit,
  readPanelCommaGroup } from "../lib/group-panel-rank-settings.ts";
import { panelApi } from "../lib/panel.ts";

test("群榜面板有效列表保留旧环境默认，支持即时保存、冲突及撤权", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-group-rank-"));
  const root = pathToFileURL(directory + "/");
  const endpoint = "/panel/api/settings/native/rank";
  const handle = panelApi("panel-owner", [], path => path === endpoint ? panelGroupRankSettings(root) : undefined);
  const saved = process.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS;
  process.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS = "123, 789";
  try {
    await mkdir(join(directory, "mounted-config"));
    await symlink("mounted-config", join(directory, "config"));
    const file = join(directory, "mounted-config/panel-rank.yaml");
    await writeFile(file, "# separate game options\nother: true\nsr: ['456']\nlegacyGroupRankLimit: 5\n");
    const url = "http://127.0.0.1" + endpoint;
    const headers = { Authorization: "Bearer panel-owner", "Content-Type": "application/json" };
    const initial = await handle(new Request(url, { headers }));
    const initialSnapshot = await initial?.json();
    const previous = initialSnapshot.values;
    const legacyRank = initialSnapshot.fields.find(({ key }: { key: string }) => key === "gsDefault");
    expect(legacyRank.hint).toContain("原铁旧参榜条件为「16 个角色且含安柏、凯亚、丽莎，或已绑定 CK」");
    expect(legacyRank.hint).toContain("目前只收录主动登记且已登录核验的角色");
    expect(initialSnapshot.fields).toContainEqual(expect.objectContaining({ key: "artifactListLimit", min: 4, max: 100 }));
    expect(previous).toEqual({ gs: ["123", "789"], sr: ["456"], gsDisabled: [], srDisabled: [],
      gsDefault: false, srDefault: false, gsLimit: 15, srLimit: 15, artifactListLimit: 28, commaGroup: 3 });
    expect(await readArtifactListLimit(root)).toBe(28);
    expect(await readPanelCommaGroup(root)).toBeUndefined();
    expect(await readGroupPanelRankEnabled("gs", 123, true, root)).toBe(true);
    expect(await readGroupPanelRankEnabled("sr", 456, false, root)).toBe(true);
    const values = { ...previous, gs: ["789"], sr: ["456", "999"], srLimit: 30, artifactListLimit: 100, commaGroup: 4 };
    const req = (next: unknown, withAuth = true) =>
      new Request(url, { method: "PUT", headers: withAuth ? headers : { "Content-Type": "application/json" },
        body: JSON.stringify({ previous, values: next }) });
    expect((await handle(req(values, false)))?.status).toBe(401);
    expect((await handle(req({ ...values, gs: ["../789"] })))?.status).toBe(400);
    expect((await handle(req({ ...values, srLimit: 31 })))?.status).toBe(400);
    for (const artifactListLimit of [3, 101, 4.5, "4"]) {
      expect((await handle(req({ ...values, artifactListLimit })))?.status).toBe(400);
    }
    for (const commaGroup of [0, 17, 3.5, "4"]) {
      expect((await handle(req({ ...values, commaGroup })))?.status).toBe(400);
    }
    expect((await handle(req({ ...values, legacyGroupRankLimit: 1 })))?.status).toBe(400);
    const changed = await handle(req(values));
    expect(changed?.status).toBe(200);
    expect((await changed?.json()).fields).toEqual(initialSnapshot.fields);
    expect(Bun.YAML.parse(await Bun.file(file).text())).toEqual({
      other: true, gs: values.gs, sr: values.sr, srLimit: 30, legacyGroupRankLimit: 5, artifactListLimit: 100, commaGroup: 4,
    });
    expect((await (await handle(new Request(url, { headers })))?.json()).values).toEqual(values);
    expect(await Bun.file(file).text()).toContain("# separate game options");
    expect(await readGroupPanelRankEnabled("gs", 123, true, root)).toBe(false);
    expect(await readGroupPanelRankEnabled("sr", 999, false, root)).toBe(true);
    expect(await readGroupPanelRankLimit("sr", 15, root)).toBe(30);
    expect(await readArtifactListLimit(root)).toBe(100);
    expect(await readPanelCommaGroup(root)).toBe(4);
    expect((await handle(req(previous)))?.status).toBe(409);
  } finally {
    if (saved === undefined) delete process.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS;
    else process.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS = saved;
    await rm(directory, { recursive: true, force: true });
  }
});

test("数字分组只改变整数部分，保留既有小数、符号、百分号和说明文字", () => {
  expect(groupPanelNumber("12345678.20", undefined)).toBe("12345678.20");
  expect(groupPanelNumber("12,345,678.20", 4)).toBe("1234,5678.20");
  expect(groupPanelNumber("-123456.00", 3)).toBe("-123,456.00");
  expect(groupPanelNumber("+12345.60%", 4)).toBe("+1,2345.60%");
  expect(groupPanelNumber("不适用 12345", 4)).toBe("不适用 12345");
});

test("迁入的旧群榜逐群状态服从面板覆盖，并只读取原状态键", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-legacy-rank-settings-"));
  const root = pathToFileURL(directory + "/");
  const previousRedis = globalThis.redis;
  const keys: string[] = [];
  Object.defineProperty(globalThis, "redis", { value: {
    get(key: string) {
      keys.push(key);
      return Promise.resolve(key.endsWith(":123:cfg") ? '{"status":1}' : null);
    },
  }, configurable: true, writable: true });
  try {
    await mkdir(join(directory, "config"));
    await writeFile(join(directory, "config/panel-rank.yaml"),
      "legacyGroupStatus: true\ngsDefault: true\nsrDefault: false\ngsLimit: 25\ngsDisabled: ['456']\nsr: ['123']\n");
    expect(await readGroupPanelRankEnabled("gs", 123, false, root)).toBe(false);
    expect(await readGroupPanelRankEnabled("gs", 789, false, root)).toBe(true);
    expect(await readGroupPanelRankEnabled("gs", 456, false, root)).toBe(false);
    expect(await readGroupPanelRankEnabled("sr", 123, false, root)).toBe(true);
    expect(await readGroupPanelRankEnabled("sr", 789, false, root)).toBe(false);
    expect(await readGroupPanelRankLimit("gs", 15, root)).toBe(25);
    expect(keys).toEqual(["miao:rank:123:cfg", "miao:rank:789:cfg"]);
  } finally {
    globalThis.redis = previousRedis;
    await rm(directory, { recursive: true, force: true });
  }
});
