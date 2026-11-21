import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zzzTuningPools } from "@lotus-yunzai/hoyo-client";
import { lockFile } from "../lib/file-lock.ts";
import { readZzzFlatLegacyGacha } from "../plugins/zzz/gacha-legacy.ts";
import { createZzzLinkHistory, type ZzzLinkedGachaSnapshot } from "../plugins/zzz/gacha-link-history.ts";

const qq = "42";
const uid = "1300000002";
const region = "prod_gf_jp";
const first = "9007199254740991000";
const modernId = "9007199254740991001";
const oldScopedId = "9007199254740991002";
const oldFlatId = "9007199254740991003";
const oldMirrorId = "9007199254740991004";

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    uid, id, name: "合成音擎", item_type: "音擎", item_id: "14101", rank_type: "4",
    gacha_type: "2", gacha_id: "0", count: "1", time: "2026-04-25 06:01:02", lang: "zh-cn", ...overrides,
  };
}

async function fixture(run: (input: {
  managed: string; legacy: string; output: string; sources: string[]; json: string;
  cli: (args?: string[], owner?: string, server?: string) => Promise<{ status: number; output: string; error: string }>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-handback-"));
  const managed = join(root, "modern");
  const legacy = join(root, "old");
  const output = join(root, "offline");
  const sources = [
    join(legacy, "plugins/Lotus-Plugin/data/zzzGachaJson", qq, uid + ".json"),
    join(legacy, "data/ZZZ-Plugin/gacha", uid + ".json"),
    join(legacy, "plugins/ZZZ-Plugin/data/gacha", uid + ".json"),
  ];
  const json = join(managed, qq, uid + ".json");
  const cli = async (args: string[] = [], owner = qq, server = region) => {
    const child = Bun.spawn([
      process.execPath, "--no-env-file", new URL("../scripts/prepare-legacy-zzz-gacha.ts", import.meta.url).pathname,
      ...args, managed, legacy, owner, uid, server,
    ], { stdout: "pipe", stderr: "pipe" });
    const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { status, output, error };
  };
  try {
    await Promise.all([...sources.map(source => mkdir(dirname(source), { recursive: true })), mkdir(output)]);
    await Promise.all(sources.map((source, index) => writeFile(source, JSON.stringify({
      "音擎回响": [row([oldScopedId, oldFlatId, oldMirrorId][index]!), row(first)],
    }) + "\r\n")));
    function draw(id: string) {
      return { id, name: "合成音擎", itemType: "音擎", itemId: "14101", rank: "4", gachaId: "1030",
        count: 1, time: "2026-04-25 06:01:02", lang: "zh-cn" } as const;
    }
    const pools = Object.entries(zzzTuningPools).map(([type, { id, name }]) => ({
      name, type, gachaType: String(id), records: type === "GACHA_TYPE_WEAPON_RETURN" ? [draw(first), draw(modernId)] : [],
    })) as ZzzLinkedGachaSnapshot["pools"];
    const modern = { uid, region, gameBiz: "nap_global", timezone: 9, pools };
    await createZzzLinkHistory(managed, lockFile).merge({ qq, uid, region }, modern, async () => {});
    await run({ managed, legacy, output, sources, json, cli });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("绝区零离线预览、原子导出与重跑保留新旧各自追加的逐抽和长 ID", () => fixture(async ({ json, sources, output, cli }) => {
  const inputs = [json, ...sources];
  const before = await Promise.all(inputs.map(file => readFile(file)));
  const preview = await cli();
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.output)).toEqual({
    mode: "dry-run", format: "ZZZ-Plugin 2057599", counts: { modern: 2, legacy: 4, total: 5 }, written: false,
  });
  expect(await readdir(output)).toEqual([]);
  const writes = await Promise.all([cli(["--export", output]), cli(["--export", output])]);
  expect(writes.map(result => result.status)).toEqual([0, 0]);
  const results = writes.map(result => JSON.parse(result.output));
  const path = results[0].path;
  expect(results[1].path).toBe(path);
  expect(results.map(result => result.written).sort()).toEqual([false, true]);
  const exported = JSON.parse(await readFile(path, "utf8"));
  expect(Object.keys(exported)).toEqual(["音擎频段", "音擎回响", "独家频段", "独家重映", "常驻频段", "邦布频段"]);
  expect(exported["音擎回响"].map((entry: Record<string, unknown>) => [entry.id, entry.gacha_type, entry.gacha_id, entry.time])).toEqual([
    ...[oldMirrorId, oldFlatId, oldScopedId].map(id => [id, "2", "0", "2026-04-25 06:01:02"]),
    ...[modernId, first].map(id => [id, "103", "1030", "2026-04-25 06:01:02"]),
  ]);
  const info = await lstat(path);
  expect(info.mode & 0o777).toBe(0o600);
  expect(JSON.parse((await cli(["--export", output])).output).written).toBe(false);
  expect((await lstat(path)).ino).toBe(info.ino);
  expect(await Promise.all(inputs.map(file => readFile(file)))).toEqual(before);

  const restored = join(output, "rehearsal");
  await mkdir(restored);
  await writeFile(join(restored, uid + ".json"), JSON.stringify(exported));
  const reread = await readZzzFlatLegacyGacha([restored], uid);
  expect(reread?.pools.find(pool => pool.name === "音擎回响")?.records.map(draw => draw.id))
    .toEqual([oldMirrorId, oldFlatId, oldScopedId, modernId, first]);

  await chmod(path, 0o644);
  expect((await cli(["--export", output])).error).toContain("已有导出文件不可复用");
}));

test("绝区零离线交还拒绝重叠目录、无新档案、同号冲突或旧目录替代", () => fixture(async ({ legacy, output, sources, cli }) => {
  expect((await cli(["--export", legacy])).status).toBe(1);
  expect((await cli(["--export", output], "43")).error).toContain("没有新版绝区零链接逐抽档案");
  expect((await cli(["--export", output], qq, "prod_gf_eu")).status).toBe(1);
  for (const [source, message] of [
    [{ "音擎回响": [row(first, { time: "2026-04-25 05:01:02" })] }, "内容不一致"],
    [{ "音擎回响": [row(first, { item_id: "14102" })] }, "内容不一致"],
    [{ "音擎回响": [row(first, { rank_type: "3" })] }, "内容不一致"],
    [{ "音擎回响": [row(first, { gacha_id: "123", gacha_type: "103" })] }, "内容不一致"],
    [{ "音擎回响": [row(first, { gacha_id: undefined })] }, "活动编号"],
    [{ "独家重映": [row(first)] }, "不同频段"],
  ] as const) {
    const contents = JSON.stringify(source);
    await writeFile(sources[0]!, contents);
    expect((await cli(["--export", output])).error).toContain(message);
    expect(await readFile(sources[0]!, "utf8")).toBe(contents);
    expect(await readdir(output)).toEqual([]);
  }
  const substituted = dirname(sources[1]!);
  await rm(substituted, { recursive: true });
  await symlink(output, substituted);
  expect((await cli(["--export", output])).error).toContain("旧逐抽路径须为副本内的实际目录");
  expect(await readdir(output)).toEqual([]);
}));
