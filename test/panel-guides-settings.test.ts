import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { panelGenshinGuideSettings, panelGuideCalendarSettings, panelGuidesSettings, panelZzzGuideSettings } from "../lib/panel-guides-settings.ts";
import { createCalendarSchedule } from "../plugins/guides/calendar-schedule.ts";
import { createGenshinStrategyPreference } from "../plugins/guides/genshin-strategy.ts";
import { guideFlags, readGuidesConfiguration } from "../plugins/guides/guide-configuration.ts";
import { readGuideAuthors } from "../plugins/guides/role-guide-collections.ts";
import { createZzzStrategySettings } from "../plugins/guides/zzz-strategy.ts";

const active = () => true;
const base = "http://127.0.0.1/panel/api/settings/native/guides";
function get() { return new Request(base); }
function put(previous: unknown, values: unknown) {
  return new Request(base, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previous, values }) });
}
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "lotus-panel-guides-"));
  const root = pathToFileURL(path + "/");
  return {
    path, root,
    async file(relative: string, content: string) {
      const target = join(path, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

test("攻略面板保留旧合集及无关 YAML，按实时作者配置和启动开关读回", async () => {
  const f = await fixture(), handler = panelGuidesSettings(f.root);
  const previousEnv = Bun.env.LOTUS_GUIDES_FORWARD;
  const collectionEnv = Bun.env.LOTUS_GUIDES_ROLE_CONFIG_DIR;
  delete Bun.env.LOTUS_GUIDES_ROLE_CONFIG_DIR;
  Bun.env.LOTUS_GUIDES_FORWARD = "0";
  try {
    const old = "news:\n  - source: 甲\n    collection_id: [123]\nolds: []\n";
    await f.file("config/guides/roleGuides.yaml", old);
    await f.file("config/guides.yaml", "# 保留此注释\nother: untouched\n");
    expect((await handler(get(), () => false)).status).toBe(401);
    const original = await (await handler(get(), active)).json();
    expect(original.values.forward).toBe(false);
    expect(original.values.gs_collections.news[0]).toEqual({ source: "甲", collection_id: [123] });
    expect(original.values).not.toHaveProperty("other");
    const desired = { ...original.values, forward: true, auto_update: false,
      gs_collections: { news: [{ source: "乙", collection_id: [456] }], olds: [] } };
    expect((await handler(put(original.values, { ...desired, sr_collections: [{ source: "../文件", collection_id: [1] }] }), active)).status).toBe(400);
    const saved = await handler(put(original.values, desired), active);
    expect(saved.status).toBe(200);
    expect((await saved.json()).values).toEqual(desired);
    expect(guideFlags(await readGuidesConfiguration(f.root))).toEqual({ forward: true, auto_update: false });
    expect(await readGuideAuthors("gs", join(f.path, "config/guides"), f.root)).toEqual(desired.gs_collections);
    const content = await readFile(join(f.path, "config/guides.yaml"), "utf8");
    expect(content).toContain("# 保留此注释");
    expect(content).toContain("other: untouched");
    expect(content).not.toContain("sr_collections");
    expect(await readFile(join(f.path, "config/guides/roleGuides.yaml"), "utf8")).toBe(old);
    expect((await handler(put(original.values, desired), active)).status).toBe(409);
  } finally {
    if (previousEnv === undefined) delete Bun.env.LOTUS_GUIDES_FORWARD;
    else Bun.env.LOTUS_GUIDES_FORWARD = previousEnv;
    if (collectionEnv !== undefined) Bun.env.LOTUS_GUIDES_ROLE_CONFIG_DIR = collectionEnv;
    await f.cleanup();
  }
});

test("原神和绝区零编号面板与聊天共用存档，校验编号和旧值冲突", async () => {
  const f = await fixture();
  const previousCache = Bun.env.LOTUS_GUIDES_ROLE_DIR;
  const previousZzz = Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR;
  delete Bun.env.LOTUS_GUIDES_ROLE_DIR;
  delete Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR;
  try {
    await f.file("plugins/genshin/config/mys.set.yaml", "defaultSource: 4\n");
    await f.file("plugins/ZZZ-Plugin/config/guide.yaml", 'default_guide: all\nmax_forward_guides: "2"\n');
    const gs = panelGenshinGuideSettings(f.root), zzz = panelZzzGuideSettings(f.root);
    expect((await (await gs(get(), active)).json()).values).toEqual({ defaultSource: 4 });
    expect((await (await zzz(get(), active)).json()).values).toEqual({ default_guide: 0, max_forward_guides: 2 });
    expect((await gs(put({ defaultSource: 4 }, { defaultSource: 8 }), active)).status).toBe(400);
    expect((await gs(put({ defaultSource: 4 }, { defaultSource: 7 }), active)).status).toBe(200);
    const gPrefs = createGenshinStrategyPreference(join(f.path, "data/guides/roleGuides/genshin-strategy.json"));
    expect(await gPrefs.get()).toBe(7);
    await gPrefs.set(3);
    expect((await gs(put({ defaultSource: 7 }, { defaultSource: 2 }), active)).status).toBe(409);
    const zBefore = { default_guide: 0, max_forward_guides: 2 };
    expect((await zzz(put(zBefore, { default_guide: 7, max_forward_guides: 0 }), active)).status).toBe(400);
    const changed = { default_guide: 5, max_forward_guides: 2 };
    expect((await zzz(put(zBefore, changed), active)).status).toBe(200);
    const zPrefs = createZzzStrategySettings({ cache: join(f.path, "data/guides/roleGuides"), legacyRoot: join(f.path, "plugins/ZZZ-Plugin") });
    expect(await zPrefs.read()).toEqual(changed);
    expect(await readFile(join(f.path, "data/guides/roleGuides/zzz-strategy.json"), "utf8")).toBe('{"default_guide":5}\n');
    await zPrefs.write({ max_forward_guides: 4 });
    expect((await zzz(put(changed, zBefore), active)).status).toBe(409);
  } finally {
    if (previousCache !== undefined) Bun.env.LOTUS_GUIDES_ROLE_DIR = previousCache;
    if (previousZzz !== undefined) Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR = previousZzz;
    await f.cleanup();
  }
});

test("面板更新日历名单和任务即时生效，取消任务阻止正在渲染的消息继续发送", async () => {
  const f = await fixture(), controller = new AbortController();
  const jobs = new Map<string, () => Promise<void>>();
  const rendering = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const clock = "0 0 9 * * *";
  let sent = 0;
  const setup = await createCalendarSchedule({
    root: f.root, signal: controller.signal, lockFile,
    register(cron, type, run) {
      const key = `${type}:${cron}`;
      jobs.set(key, run);
      return () => { jobs.delete(key); };
    },
    targets: async groups => groups.map(groupId => ({ groupId, send: async () => { sent++; return "confirmed"; } })),
    async render() { rendering.resolve(); await release.promise; return "测试图"; },
  });
  const handler = panelGuideCalendarSettings(() => setup);
  try {
    const blank = { whiteList: [], blackList: [], tasks: [] };
    expect((await (await handler(get(), active)).json()).values).toEqual(blank);
    const desired = { whiteList: [101, 102], blackList: [102], tasks: [{ cron: clock, type: "G" }] };
    expect((await handler(put(blank, { ...desired, tasks: [{ cron: "invalid", type: "G" }] }), active)).status).toBe(400);
    expect((await handler(put(blank, desired), active)).status).toBe(200);
    expect(jobs.size).toBe(1);
    const run = jobs.get("G:" + clock)!;
    const running = run();
    await rendering.promise;
    expect((await handler(put(desired, blank), active)).status).toBe(200);
    expect(jobs.size).toBe(0);
    release.resolve();
    await running;
    await run();
    expect(sent).toBe(0);
    expect((await handler(put(desired, blank), active)).status).toBe(409);
  } finally {
    release.resolve();
    await setup.stop();
    await f.cleanup();
  }
});
