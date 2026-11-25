import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { migrateInstallation } from "../scripts/migrate.ts";
import { initializeTerminalOwner } from "../lib/initialize-terminal-owner.ts";
import { readMasterPermissions } from "../lib/permissions.ts";
import { readLocalConfig } from "../lib/config.ts";
import { generateCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";

for (const generation of [1, 2]) {
  test.skipIf(!Bun.which("git"))(`一代/二代真实迁移后初始化保留主人与访问策略，不重新排期：第${generation}代`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "lotus-migrated-owner-"));
    const source = join(parent, "old"), target = join(parent, "new");
    const originals = new Map<string, string>();
    async function put(base: string, path: string, value: string) {
      await mkdir(dirname(join(base, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(base, path), value, { mode: 0o600 });
      if (base === source) originals.set(path, value);
    }
    const other = { master: ["59904491:42", "stdin:stdin"], masterQQ: ["42", "stdin"],
      blackGroup: [20001], blackUser: [43], whiteGroup: [10001], whiteUser: [42],
      disablePrivate: true, disableMsg: false, autoFriend: 0, autoGroup: 0, autoQuit: 5 };
    const now = Date.parse("2026-11-25T12:00:00+08:00");
    const profiles = [{ qq: "42", profileId: 2, enabled: true }];
    const plans = [
      generateCheckinSchedulePlan({ now, date: "2026-11-25", profiles, config: { mode: "fixed", fixed_time: "23:58" } }),
      generateCheckinSchedulePlan({ now, date: "2026-11-26", profiles, config: { mode: "random" }, random: () => .371 }),
    ];
    try {
      await put(source, "config/config/other.yaml", "# 旧访问策略\n" + Bun.YAML.stringify(other));
      await put(source, "config/config/bot.yaml", "update_time: 0\n");
      const prefix = "plugins/Lotus-Plugin"; // 二代也实际使用这个旧目录名。
      const account = { cookie: "ltuid=71;ltoken=fixture", stuid: "71", stoken: "fixture", mid: "fixture-mid" };
      if (generation === 1) {
        await put(source, `${prefix}/MihoyoBBSTools/config/42-2.yaml`, Bun.YAML.stringify({ version: 15, enable: true, account }));
        await put(source, `${prefix}/config/config.yaml`, Bun.YAML.stringify({ schedule: "0 58 23 * * *" }));
      } else {
        await put(source, `${prefix}/data/users/42-2.yaml`, Bun.YAML.stringify({ version: 1, enabled: true,
          user: { qq: "42" }, profile: { id: 2 }, account }));
        await put(source, `${prefix}/config/global.yaml`, Bun.YAML.stringify({ scheduler: { mode: "fixed", fixed_time: "23:58" } }));
      }
      for (const plan of plans) await put(source, `${prefix}/data/schedules/${plan.date}.json`, JSON.stringify(plan));
      await put(target, "package.json", '{"name":"lotus-yunzai"}');
      await put(target, "plugins/genshin/module.ts", "export default {};\n");
      for (const args of [["init"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]]) {
        expect(Bun.spawnSync(["git", ...args], { cwd: target, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
      }
      expect((await migrateInstallation(source, target)).status).toBe("published");
      const root = pathToFileURL(target + "/");
      const legacyBytes = await readFile(join(target, "config/config/other.yaml"), "utf8");
      const planBytes = await Promise.all(plans.map(plan => readFile(join(target, "data/schedules", plan.date + ".json"), "utf8")));
      for (let i = 0; i < 2; i++) {
        // 与 scripts/startup.ts 相同的真实初始化入口，不替换文件操作或权限读取。
        expect(await initializeTerminalOwner(root, new AbortController().signal)).toBe(false);
        const permissions = await readMasterPermissions(root);
        expect(permissions.isMaster(59904491, 42)).toBe(true); expect(permissions.terminal).toBe(true);
        expect(permissions.isMaster(59904491, 44)).toBe(false);
        expect(await readLocalConfig(root, "other")).toEqual(other);
        expect(await Bun.file(join(target, "config/other.yaml")).exists()).toBe(false);
        expect(await readFile(join(target, "config/config/other.yaml"), "utf8")).toBe(legacyBytes);
        for (const [index, plan] of plans.entries()) {
          const saved = await readFile(join(target, "data/schedules", plan.date + ".json"), "utf8");
          expect(saved).toBe(planBytes[index]!);
          const { importedLegacy, ...logical } = JSON.parse(saved);
          expect(logical).toEqual(plan); expect(importedLegacy).toEqual(["Lotus-Plugin"]);
        }
        expect((await readLocalConfig(root, "global")).scheduler).toMatchObject({ mode: "fixed", fixed_time: "23:58" });
      }
      for (const [path, bytes] of originals) expect(await readFile(join(source, path), "utf8")).toBe(bytes);
    } finally { await rm(parent, { recursive: true, force: true }); }
  }, 60_000);
}
