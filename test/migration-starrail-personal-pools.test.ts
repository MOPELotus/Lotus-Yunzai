import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { migrateInstallation } from "../scripts/migrate.ts";
import { createStarRailSimulation } from "../plugins/starrail/simulation/commands.ts";
import { createPersonalWarpPoolReader, parseLegacyPersonalPools, pickPersonalPhase } from "../plugins/starrail/simulation/personal-pools.ts";
import { createWarpPoolSource } from "../plugins/starrail/simulation/pools.ts";
import { createWarpSettingsStore } from "../plugins/starrail/simulation/settings.ts";

test("normal migration activates archived Flower personal pools only for the owning QQ", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-starrail-pool-"));
  const source = join(root, "old"), target = join(root, "next");
  try {
    await mkdir(source);
    await mkdir(join(target, "plugins/starrail"), { recursive: true });
    await writeFile(join(target, "package.json"), '{"name":"lotus-yunzai"}');
    await writeFile(join(target, "plugins/starrail/package.json"), '{"name":"@lotus-yunzai/starrail"}');
    for (const args of [["init", "-q"], ["add", "package.json", "plugins"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    }
    async function put(relative: string, contents: string) {
      const file = join(source, relative);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    const relative = "plugins/flower-plugin/GachaMOD/StarRail/data";
    await put("plugins/flower-plugin/package.json", '{"name":"flower-plugin","version":"1.0.0"}');
    const original = `
"0":
  up5: [希儿]
  up5_2: [景元]
  up4: [青雀]
  weapon5: [于夜色中]
  weapon4: [论剑]
  startTime: 2026-11-22 06:00:00
  endTime: 2026-11-26 06:00:00
"1":
  up5: [银枝]
  startTime: 2026-11-29 06:00:00
  endTime: 2026-12-02 06:00:00
`;
    await put(`${relative}/42/pool.yaml`, original);
    await put(`${relative}/43/pool.yaml`, "- up5: [卡芙卡]\n");
    await put(`${relative}/44/pool.yaml`, "up5: [false]");
    await put(`${relative}/non-numeric/pool.yaml`, "up5: [卡芙卡]");
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "published",
      starRailPersonalPools: { accounts: 2, deferred: 1 } });
    const archive = join(target, "data/starrail/simulation");
    expect(await readFile(join(source, relative, "42/pool.yaml"), "utf8")).toBe(original);
    expect((await lstat(join(archive, "personal-pools/42/1.json"))).mode & 0o777).toBe(0o600);
    const read = createPersonalWarpPoolReader(archive, lockFile);
    const at = Date.parse("2026-11-24T10:00:00+08:00");
    expect((await read("42", at))?.up5).toEqual(["希儿"]);
    expect((await read("42", Date.parse("2026-11-27T10:00:00+08:00")))?.up5).toEqual(["银枝"]);
    expect((await read("42", Date.parse("2026-12-03T10:00:00+08:00")))?.up5).toEqual(["银枝"]);
    expect((await read("43", at))?.up5).toEqual(["卡芙卡"]);
    expect(await read("44", at)).toBeUndefined();

    await createWarpSettingsStore(lockFile, archive).update(current => ({ ...current, automaticPools: false,
      poolNames: { characterFive: ["镜流"], coneFive: ["此身为剑"] } }));
    const run = createStarRailSimulation({ directory: archive, lockFile, signal: new AbortController().signal,
      poolSource: createWarpPoolSource(""), now: () => at, random: () => 0,
      render: async () => { throw new Error("fixture text"); } });
    const reply = async (command: string, user_id: number, more = {}) => {
      const result = await run(command, { user_id, ...more });
      return typeof result === "object" && result && "type" in result && result.type === "recallable" ? result.message : result;
    };
    expect(await reply("#星铁单抽", 42)).toContain("个人活动跃迁 · 希儿");
    expect(await reply("#星铁单抽2", 42)).toContain("个人活动跃迁 · 景元");
    expect(await reply("#星铁单抽光锥", 42)).toContain("个人活动跃迁 · 于夜色中");
    expect(await reply("#星铁单抽常驻", 42)).toContain("群星跃迁");
    expect(await reply("#星铁单抽", 43)).toContain("个人活动跃迁 · 卡芙卡");
    expect(await reply("#星铁单抽", 45, { sender: { user_id: 42 } })).toContain("自定义活动跃迁 · 镜流");
    expect(await reply("#星铁单抽", 42, { isDelegated: true })).toContain("自己的会话");
    const state = JSON.parse(await readFile(join(archive, "42/1.json"), "utf8"));
    expect(state.balance).toMatchObject({ special: 97, regular: 9 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("legacy single-object personal pool with no dates remains selectable", () => {
  const saved = parseLegacyPersonalPools({ up5: ["丹恒•饮月"] });
  expect(pickPersonalPhase(saved.phases, 0)?.up5).toEqual(["丹恒•饮月"]);
});
