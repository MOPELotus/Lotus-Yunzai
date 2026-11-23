import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageLegacyLolomiConfig } from "../lib/migration-lolomi-config.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

const plugin = { path: "plugins/lolomi-calc", status: "archive", kind: "directory",
  reason: rejectionReason(["lolomi-calc"], [])!, identity: "fixture" } as const;

test("旧原神算伤配置采用现用 YAML，保留关闭与独立评分开关，忽略无消费字段", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-lolomi-migration-"));
  const archive = join(root, "archive");
  const stage = join(root, "stage");
  const input = join(archive, "lolomi-calc", "config");
  const presets = "lolomiartis: true\nlolomicalc: true\nengineMode: auto\n";
  const config = "lolomiartis: false\nlolomicalc: false\ntemplateteam: true\nconscompare: false\nengineMode: miao\npanelmodel: 1\n";
  try {
    await mkdir(join(input, "system"), { recursive: true });
    await mkdir(stage);
    await writeFile(join(input, "config.yaml"), config);
    await writeFile(join(input, "system", "config.yaml"), presets);
    expect(await stageLegacyLolomiConfig(archive, stage, [plugin])).toEqual({ active: true, deferred: false });
    const output = join(stage, "config", "genshin-damage.yaml");
    expect(Bun.YAML.parse(await readFile(output, "utf8"))).toEqual({
      lolomiartis: false, lolomicalc: false, templateteam: true, conscompare: false, engineMode: "miao",
    });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(input, "config.yaml"), "utf8")).toBe(config);
    await rm(output);
    await writeFile(join(input, "config.yaml"), "lolomicalc: true\n");
    expect(await stageLegacyLolomiConfig(archive, stage, [plugin])).toEqual({ active: true, deferred: false });
    expect(Bun.YAML.parse(await readFile(output, "utf8"))).toEqual({ lolomiartis: false, lolomicalc: true, engineMode: "auto" });
    await rm(output);
    await rm(join(input, "config.yaml"));
    expect(await stageLegacyLolomiConfig(archive, stage, [plugin])).toEqual({ active: true, deferred: false });
    expect(Bun.YAML.parse(await readFile(output, "utf8"))).toEqual(Bun.YAML.parse(presets));
    await rm(output);
    await writeFile(join(input, "config.yaml"), "lolomiartis: broken\n");
    expect(await stageLegacyLolomiConfig(archive, stage, [plugin])).toEqual({ active: false, deferred: true });
    expect(await Bun.file(output).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(!Bun.which("git"))("一体化迁移归档旧插件，启用原神配置并保留迁移后的追加设置", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-damage-migration-publish-"));
  const source = join(root, "old");
  const target = join(root, "new");
  const folder = "plugins/renamed-rule-bundle";
  const input = join(folder, "config", "config.yaml");
  const original = "lolomiartis: false\nconscompare: false\n";
  try {
    await Promise.all([mkdir(join(source, folder, "config"), { recursive: true }),
      mkdir(join(target, "plugins"), { recursive: true })]);
    await writeFile(join(source, folder, "package.json"), '{"name":"lolomi-calc"}');
    await writeFile(join(source, input), original);
    await writeFile(join(target, "package.json"), '{"name":"lotus-yunzai"}');
    await writeFile(join(target, "plugins/.fixture"), "fixture");
    for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
    }
    const report = { active: true, deferred: false };
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "published", lolomi: report });
    const output = join(target, "config", "genshin-damage.yaml");
    expect(Bun.YAML.parse(await readFile(output, "utf8"))).toEqual({
      lolomiartis: false, conscompare: false, engineMode: "auto",
    });
    expect(await readFile(join(target, "backup", input), "utf8")).toBe(original);
    expect(await readFile(join(source, input), "utf8")).toBe(original);
    await writeFile(output, "lolomiartis: true\n");
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published", lolomi: report });
    expect(await readFile(output, "utf8")).toBe("lolomiartis: true\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
