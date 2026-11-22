import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelGroupRankSettings, readGroupPanelRankEnabled } from "../lib/group-panel-rank-settings.ts";
import { panelApi } from "../lib/panel.ts";

test("群榜面板有效列表保留旧环境默认，支持即时保存、冲突及撤权", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-group-rank-"));
  const root = pathToFileURL(directory + "/");
  const endpoint = "/panel/api/settings/native/rank";
  const handle = panelApi("panel-owner", [], path => path === endpoint ? panelGroupRankSettings(root) : undefined);
  const saved = process.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS;
  process.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS = "123, 789";
  try {
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/panel-rank.yaml");
    await writeFile(file, "# separate game options\nother: true\nsr: ['456']\n");
    const url = "http://127.0.0.1" + endpoint;
    const headers = { Authorization: "Bearer panel-owner", "Content-Type": "application/json" };
    const initial = await handle(new Request(url, { headers }));
    const previous = (await initial?.json()).values;
    expect(previous).toEqual({ gs: ["123", "789"], sr: ["456"] });
    expect(await readGroupPanelRankEnabled("gs", 123, true, root)).toBe(true);
    expect(await readGroupPanelRankEnabled("sr", 456, false, root)).toBe(true);
    const values = { gs: ["789"], sr: ["456", "999"] };
    const req = (next: unknown, withAuth = true) =>
      new Request(url, { method: "PUT", headers: withAuth ? headers : { "Content-Type": "application/json" },
        body: JSON.stringify({ previous, values: next }) });
    expect((await handle(req(values, false)))?.status).toBe(401);
    expect((await handle(req({ gs: ["../789"], sr: [] })))?.status).toBe(400);
    expect((await handle(req(values)))?.status).toBe(200);
    expect(Bun.YAML.parse(await Bun.file(file).text())).toEqual({ other: true, ...values });
    expect(await Bun.file(file).text()).toContain("# separate game options");
    expect(await readGroupPanelRankEnabled("gs", 123, true, root)).toBe(false);
    expect(await readGroupPanelRankEnabled("sr", 999, false, root)).toBe(true);
    expect((await handle(req(previous)))?.status).toBe(409);
  } finally {
    if (saved === undefined) delete process.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS;
    else process.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS = saved;
    await rm(directory, { recursive: true, force: true });
  }
});
