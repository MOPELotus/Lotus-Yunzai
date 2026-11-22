import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageLegacyAtlasState } from "../lib/migration-atlas-state.ts";
import { discoverRuntimeAtlasDataDirectory } from "../plugins/atlas/legacy-atlas-directory.ts";
import { parseAtlasUpdatePolicy } from "../plugins/atlas/update-policy.ts";

async function write(file: string, bytes: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

async function fixture(run: (base: string, source: string, stage: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "lotus-atlas-migrate-"));
  try {
    const source = join(base, "old");
    const stage = join(base, "new");
    await mkdir(source, { mode: 0o700 });
    await mkdir(stage, { mode: 0o700 });
    await run(base, source, stage);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("保留固定旧宿主的定时语义和分类范围，只迁现行 Atlas 读取的配置", async () => {
  await fixture(async (_, source, stage) => {
    const old = join(source, "plugins/Lotus-Plugin/config/global.yaml");
    const contents = [
      "legacy_secret: must-not-follow",
      "atlas:",
      "  data_root: data/atlas",
      "  initial_command: /tmp/untrusted",
      "  update_command: /tmp/untrusted",
      "  sync_gallery: true",
      "  max_results: 8",
      "  version_channel: live",
      "  update_args: ['src/scrape.mjs', '--mode', 'incremental', '--page', 'hsr=lightcone']",
      "  challenge_args: ['--page', 'zzz=shiyu']",
      "  auto_update:",
      "    enable: true",
      '    check_cron: "0 0 */6 * * * *"',
      '    challenge_cron: ""',
      "    run_on_missing_data: false",
    ].join("\n");
    await write(old, contents);
    const staged = join(stage, "config/global.yaml");
    await write(staged, "scheduler: {mode: fixed}\n");
    expect(await stageLegacyAtlasState(source, stage)).toEqual({ settings: "staged", dataset: {status: "absent"}, themeFiles: 0 });
    const result = Bun.YAML.parse(await readFile(staged, "utf8")) as Record<string, unknown>;
    expect(result).toEqual({
      scheduler: { mode: "fixed" },
      atlas: { version_channel: "live", update_args: ["--page", "hsr=lightcone"], challenge_args: ["--page", "zzz=shiyu"],
        auto_update: { enable: true, check_cron: "0 0 */6 * * *", run_on_missing_data: false } },
    });
    const policy = parseAtlasUpdatePolicy(result.atlas);
    expect(policy.version).toEqual({ selections: ["hsr/lightcone"], cron: "0 0 */6 * * *" });
    expect(policy.challenge).toEqual({ selections: ["zzz/shiyu"], cron: "0 15 */2 * * *" });
    expect(await readFile(old, "utf8")).toBe(contents);
  });
});

test("自然启用旧导出、图鉴记录与核过哈希的原图，且排除无关文件", async () => {
  await fixture(async (_, source, stage) => {
    const donor = join(source, "data/atlas");
    const item = "items/gi/weapon/11513.json", image = "gallery/gi/sword.webp";
    const bytes = "旧原图";
    const map = JSON.stringify({ games: { gi: { locales: { zh: { pages: { weapon: { id: "weapon", version: "7.2", recorded: true,
      sampled: false, totalRecordCount: 1, recordCount: 1, records: {
        "11513": { id: "11513", name: "旧武器", path: item, hasDetail: false },
      },
    } } } } } } });
    await write(join(donor, "data/map.json"), map);
    await write(join(donor, "data", item), JSON.stringify({
      meta: { gameId: "gi", pageId: "weapon", locale: "zh", recordId: "11513", name: "旧武器", version: "7.2", hasDetail: false,
        images: [{ localPath: image, status: "downloaded", sha256: createHash("sha256").update(bytes).digest("hex") }] },
      content: { list: {}, detail: null },
    }));
    await write(join(donor, image), bytes);
    await write(join(donor, "download.js"), "untrusted legacy script");
    const root = join(stage, "data/atlas");
    expect(await stageLegacyAtlasState(source, stage)).toEqual({ settings: "absent", dataset: {status: "staged",pages: 1,images: 1}, themeFiles: 0});
    expect(await discoverRuntimeAtlasDataDirectory(root)).toEqual({ root: join(root, "data"), version: null, legacy: false });
    expect(await Bun.file(join(root, image)).text()).toBe(bytes);
    expect(await Bun.file(join(root, "download.js")).exists()).toBe(false);
    expect(await readFile(join(donor, "data/map.json"), "utf8")).toBe(map);
    const legacyStage = join(dirname(stage), "legacy-stage");
    await mkdir(legacyStage, { mode: 0o700 });
    const legacyParent = join(source, "plugins/Lotus-Plugin/data");
    await mkdir(legacyParent, { recursive: true });
    await rename(donor, join(legacyParent, "atlas"));
    expect(await stageLegacyAtlasState(source, legacyStage)).toEqual({
      settings: "absent", dataset: { status: "staged", pages: 1, images: 1 }, themeFiles: 0,
    });
  });
});

test("不遍历外部图鉴路径、拒绝副本中的链接并保留暂存现有 Atlas 设置", async () => {
  await fixture(async (base, source, stage) => {
    const global = join(source, "plugins/Lotus-Plugin/config/global.yaml");
    await write(global, "atlas: {data_root: /does-not-read, auto_update: {enable: false}}\n");
    const current = join(stage, "config/global.yaml");
    await write(current, "atlas: {version_channel: latest}\n");
    expect(await stageLegacyAtlasState(source, stage)).toEqual({
      settings: "existing", dataset: {status: "external-or-unsupported"}, themeFiles: 0,
    });
    expect(await readFile(current,"utf8")).toBe("atlas: {version_channel: latest}\n");
    await rm(global);
    const outside = join(base, "outside.yaml");
    await write(outside, "atlas: {version_channel: live}\n");
    await symlink(outside, global);
    await expect(stageLegacyAtlasState(source, stage)).rejects.toThrow("实体目录和无硬链接普通文件");
  });
});


test("明确指定的非中文范围保持禁用，未指定的自动任务仍用默认范围", async () => {
  await fixture(async (_, source, stage) => {
    await write(join(source, "plugins/Lotus-Plugin/config/global.yaml"),
      'atlas: {update_args: ["src/scrape.mjs", "--locale", "en"]}\n');
    await stageLegacyAtlasState(source, stage);
    const { atlas } = Bun.YAML.parse(await readFile(join(stage, "config/global.yaml"), "utf8")) as Record<string, unknown>;
    expect(atlas).toEqual({ update_args: ["--locale", "en"] });
    const policy = parseAtlasUpdatePolicy(atlas);
    expect(policy.version).toEqual({ selections: [] });
    expect(policy.challenge.cron).toBe("0 15 */2 * * *");
  });
});

test("只迁原画像和星铁部件索引实际引用的本地图，不读索引越界路径", async () => {
  await fixture(async (_, source, stage) => {
    const theme = join(source, "plugins/Lotus-ReFactor/resources/miao-theme");
    const output = join(stage, "data/atlas/theme");
    const png = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
    await write(join(theme, "portraits/index.json"),
      JSON.stringify({ "gi-10000005": "gi-10000005.webp", "gi-10000007": "../card-bg.png", "zzz-12": "zzz-12.webp" }));
    await writeFile(join(theme,"portraits/gi-10000005.webp"), png);
    await write(join(theme,"relic-parts/index.json"), JSON.stringify({
      "sr-31011": { file: "sr-101-1.webp", name: "过客的逢春木簪" },
      "sr-41011": { file: "sr-101-1.webp", name: "过客的逢春木簪" },
      "gs-51430": { file: "gs-51430.webp", name: "无关文件" },
    }));
    await writeFile(join(theme,"relic-parts/sr-101-1.webp"),png);
    await writeFile(join(theme,"relic-parts/gs-51430.webp"),png);
    expect((await stageLegacyAtlasState(source, stage)).themeFiles).toBe(2);
    expect(await Bun.file(join(output,"portraits/index.json")).json()).toEqual({"gi-10000005":"gi-10000005.webp"});
    expect(await Bun.file(join(output,"relic-parts/index.json")).json()).toEqual({
      "sr-31011": { file: "sr-101-1.webp", name: "过客的逢春木簪" },
      "sr-41011": { file: "sr-101-1.webp", name: "过客的逢春木簪" },
    });
    expect(await Bun.file(join(output,"relic-parts/gs-51430.webp")).exists()).toBe(false);
    expect(await readFile(join(output,"portraits/gi-10000005.webp"))).toEqual(png);
  });
});
