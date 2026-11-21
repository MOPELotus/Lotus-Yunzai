import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const qq = "42";
const uid = "100001211";
const first = "177427520000001211";
const modernId = "177427520000009411";
const oldId = "177427520000009499";

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, uid, name: "布洛妮娅", item_type: "角色", item_id: "1101", rank_type: "5",
    gacha_type: "11", gacha_id: "2005", time: "2025-07-15 12:00:09", ...overrides,
  };
}

async function fixture(run: (input: {
  managed: string; legacy: string; output: string; current: string; original: string;
  cli: (args?: string[], timezone?: string) => Promise<{ status: number; output: string; error: string }>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-star-rail-handback-"));
  const managed = join(root, "modern");
  const legacy = join(root, "old");
  const output = join(root, "offline");
  const current = join(managed, qq, uid + ".json");
  const original = join(legacy, qq, uid, "11.json");
  const cli = async (args: string[] = [], timezone = "8") => {
    const process = Bun.spawn([
      globalThis.process.execPath, "--no-env-file", new URL("../scripts/prepare-legacy-star-rail-gacha.ts", import.meta.url).pathname,
      ...args, managed, legacy, qq, uid, timezone,
    ], { stdout: "pipe", stderr: "pipe" });
    const [status, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { status, output, error };
  };
  try {
    await Promise.all([mkdir(dirname(current), { recursive: true }), mkdir(dirname(original), { recursive: true }), mkdir(output)]);
    const existing = row(first);
    await writeFile(current, JSON.stringify({
      version: 1, qq, uid, lang: "zh-cn", timezone: 0,
      records: [row(first, { time: "2025-07-15 04:00:09" }), row(modernId, { time: "2025-07-15 04:01:09" })],
    }));
    await writeFile(original, JSON.stringify([existing, row(oldId, { time: "2025-07-15 12:05:10", lang: "zh-cn" })]) + "\r\n");
    await run({ managed, legacy, output, current, original, cli });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("只读预览并原子发布，可重跑且保留两边各自新增的星铁长编号", () => fixture(async ({ current, original, output, cli }) => {
  const before = await Promise.all([readFile(current), readFile(original)]);
  const preview = await cli();
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.output)).toEqual({
    mode: "dry-run", format: "SRGF v1.0", counts: { modern: 2, legacy: 2, total: 3 }, written: false,
  });
  expect(await readdir(output)).toEqual([]);
  const writes = await Promise.all([cli(["--export", output]), cli(["--export", output])]);
  expect(writes.map(item => item.status)).toEqual([0, 0]);
  const results = writes.map(item => JSON.parse(item.output));
  expect(results.map(result => result.written).sort()).toEqual([false, true]);
  expect(results[0].path).toBe(results[1].path);
  const candidate = await readFile(results[0].path);
  const exported = JSON.parse(candidate.toString());
  expect(exported.info).toMatchObject({ uid, region_time_zone: 8, srgf_version: "v1.0" });
  expect(exported.list.map((entry: { id: string; time: string }) => [entry.id, entry.time])).toEqual([
    [first, "2025-07-15 12:00:09"], [modernId, "2025-07-15 12:01:09"], [oldId, "2025-07-15 12:05:10"],
  ]);
  const previous = await lstat(results[0].path);
  expect(previous.mode & 0o777).toBe(0o600);
  expect(JSON.parse((await cli(["--export", output])).output).written).toBe(false);
  expect((await lstat(results[0].path)).ino).toBe(previous.ino);
  expect(await readFile(results[0].path)).toEqual(candidate);
  expect(await Promise.all([readFile(current), readFile(original)])).toEqual(before);
}));

test("需要联动池时交还单 UID 的 UIGF，并拒绝无法安全转换的旧档和同号冲突", () => fixture(async ({ original, output, legacy, cli }) => {
  await writeFile(join(dirname(original), "21.json"), JSON.stringify([row(oldId, { gacha_type: "21" })]));
  await writeFile(original, JSON.stringify([row(first)]));
  const exported = await cli(["--export", output]);
  expect(exported.status).toBe(0);
  const result = JSON.parse(exported.output);
  expect(result.format).toBe("UIGF v4.1");
  const document = JSON.parse(await readFile(result.path, "utf8"));
  expect(document.hkrpg[0].list.map((entry: { gacha_type: string }) => entry.gacha_type)).toEqual(["11", "11", "21"]);
  expect((await cli(["--export", legacy])).status).toBe(1);

  const before = await readdir(output);
  for (const [unsupported, message] of [
    [row(first, { item_id: "1003" }), "编号相同"],
    [row(first, { name: "另一个角色" }), "名称"],
    [row(first, { id: "lotus-display-1" }), "显示占位"],
    [row("177427520000009500", { rank_type: undefined }), "缺少旧显示字段"],
  ] as const) {
    const source = JSON.stringify([unsupported]);
    await writeFile(original, source);
    const failed = await cli(["--export", output]);
    expect(failed.status).toBe(1);
    expect(failed.error).toContain(message);
    expect(await readFile(original, "utf8")).toBe(source);
    expect(await readdir(output)).toEqual(before);
  }
}));
