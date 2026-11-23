import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { panelStarRailWarpSettings } from "../lib/panel-starrail-warp-settings.ts";
import { panelApi } from "../lib/panel.ts";
import { createStarRailSimulation } from "../plugins/starrail/simulation/commands.ts";
import { createWarpSettingsStore, defaultWarpSettings, readWarpAllowance } from "../plugins/starrail/simulation/settings.ts";

const path = "/panel/api/settings/native/starrail-warp";
const endpoint = "http://localhost" + path;
const headers = { Authorization: "Bearer warp-panel-test", "Content-Type": "application/json" };
type Values = Record<string, unknown>;
type SettingsResult = { values: Values; defaults: Values };

function send(previous: Values, values: Values) {
  return new Request(endpoint, { method: "PUT", headers, body: JSON.stringify({ previous, values }) });
}

test("真实跃迁设置存储回读全局、群覆盖、撤销和概率恢复", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-panel-warp-"));
  const directory = join(work, "custom-state");
  const root = pathToFileURL(work + "/");
  const originalEnv = Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR;
  Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR = directory;
  try {
    const route = panelStarRailWarpSettings(root);
    const panel = panelApi("warp-panel-test", [], candidate => candidate === path ? route : undefined);
    const store = createWarpSettingsStore(lockFile, directory);
    const simulate = createStarRailSimulation({ lockFile, directory, signal: new AbortController().signal });
    expect((await panel(new Request(endpoint)))?.status).toBe(401);
    const original = await panel(new Request(endpoint, { headers }));
    const { values, defaults } = await original!.json() as SettingsResult;
    expect(values).toEqual(defaults);
    const altered = {
      ...values, special: 151, recallSeconds: 0, characterFour: 777, featuredFive: 80, automaticPools: false,
      groups: { "20101": { special: 82 }, "20202": { regular: 23, recallSeconds: 5 } },
      poolCharacterFive: ["昔涟", "遐蝶"],
    };
    expect((await panel(send(values, altered)))?.status).toBe(200);
    const current = await store.read();
    expect(readWarpAllowance(current)).toEqual({ special: 151, regular: 10, recallSeconds: 0 });
    expect(readWarpAllowance(current, "20101")).toEqual({ special: 82, regular: 10, recallSeconds: 0 });
    expect(readWarpAllowance(current, "20202")).toEqual({ special: 151, regular: 23, recallSeconds: 5 });
    expect(current).toMatchObject({ automaticPools: false, rates: { characterFour: 777, featuredFive: 80 },
      poolNames: { characterFive: ["昔涟", "遐蝶"] } });
    expect(await simulate("#星铁我的星轨票", { user_id: 55, group_id: 20101 })).toContain("82 张星轨专票");
    expect(await simulate("#星铁我的星轨票", { user_id: 56, group_id: 20202 })).toBe("今日你还有 151 张星轨专票和 23 张星轨通票。");
    expect((await panel(send(values, altered)))?.status).toBe(409);

    const reset = { ...altered, characterFour: defaults.characterFour, featuredFive: defaults.featuredFive,
      groups: { "20202": altered.groups["20202"] } };
    expect((await panel(send(altered, reset)))?.status).toBe(200);
    expect((await store.read()).rates).toEqual(defaultWarpSettings().rates);
    expect(readWarpAllowance(await store.read(), "20101")).toEqual(readWarpAllowance(await store.read()));
    expect(await simulate("#星铁我的星轨票", { user_id: 55, group_id: 20101 })).toContain("82 张星轨专票");
    expect(await simulate("#星铁我的星轨票", { user_id: 57, group_id: 20101 })).toContain("151 张星轨专票");
    expect((await panel(send(reset, { ...defaults, groups: reset.groups })))?.status).toBe(200);
    expect(await store.read()).toEqual({ ...defaultWarpSettings(), groups: reset.groups });
  } finally {
    if (originalEnv === undefined) delete Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR;
    else Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR = originalEnv;
    await rm(work, { recursive: true, force: true });
  }
});

test("星铁模拟跃迁设置拒绝无效字段和保存前撤销的会话", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-panel-warp-auth-"));
  const root = pathToFileURL(work + "/");
  const originalEnv = Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR;
  delete Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR;
  try {
    const route = panelStarRailWarpSettings(root);
    const store = createWarpSettingsStore(lockFile, join(work, "data/starrail/simulation"));
    const { values } = await (await route(new Request(endpoint), () => true)).json() as SettingsResult;
    for (const invalid of [
      { featuredFive: 101 }, { characterFive: 1.2 }, { groups: { "01": { special: 3 } } },
      { groups: { "20101": { recallSeconds: 121 } } }, { groups: { "20101": { other: 15 } } },
      { poolConeFour: ["光锥", "光锥"] }, { extra: true },
    ]) expect((await route(send(values, { ...values, ...invalid }), () => true)).status).toBe(400);
    let checks = 0;
    expect((await route(send(values, { ...values, special: 101 }), () => ++checks < 4)).status).toBe(401);
    expect(checks).toBeGreaterThanOrEqual(4);
    expect(await store.read()).toEqual(defaultWarpSettings());
  } finally {
    if (originalEnv === undefined) delete Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR;
    else Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR = originalEnv;
    await rm(work, { recursive: true, force: true });
  }
});
