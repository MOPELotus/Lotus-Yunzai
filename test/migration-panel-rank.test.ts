import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageLegacyPanelRankConfig } from "../lib/migration-panel-rank.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

async function put(root: string, path: string, contents: string) {
  const filename = join(root, path);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, contents, { mode: 0o600 });
}

test.skipIf(!Bun.which("git"))("迁移入口从已归档的旧插件配置恢复原铁群榜，并在重跑时保留面板后续设置", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-migration-rank-"));
  try {
    const source = join(root, "old");
    const target = join(root, "new");
    const plugin = "plugins/renamed-public-panel";
    const path = `${plugin}/config/cfg.js`;
    const original = [
      "/** ************ 【群设置】 ************* */",
      "/*",
      "export const groupRank = false",
      "*/",
      "export const groupRank = true // 官方字段",
      "export const rankNumber = 30;",
      "throw new Error('迁移不得执行旧配置');",
    ].join("\r\n");
    await put(source, `${plugin}/package.json`, '{"name":"miao-plugin"}');
    await put(source, path, original);
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    await put(target, "plugins/.fixture", "fixture");
    for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
    }
    const report = { active: true, deferred: false };
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "published", panelRank: report });
    const published = join(target, "config/panel-rank.yaml");
    expect(Bun.YAML.parse(await readFile(published, "utf8"))).toEqual({
      gsDefault: true, srDefault: true, gsLimit: 30, srLimit: 30, legacyGroupStatus: true,
    });
    expect((await lstat(published)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(target, "backup", path), "utf8")).toBe(original);
    expect(await readFile(join(source, path), "utf8")).toBe(original);
    const saved = "gsDefault: false\nsrDefault: true\nsrDisabled: ['42']\n";
    await writeFile(published, saved);
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published", panelRank: report });
    expect(await readFile(published, "utf8")).toBe(saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("从旧配置读取明确关闭，遇到需执行代码的设置则标为待核对", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-migration-rank-stage-"));
  try {
    const archive = join(root, "archive");
    const stage = join(root, "stage");
    const archived = "miao-plugin/config/cfg.js";
    const entries = [{ path: "plugins/miao-plugin", status: "archive", kind: "directory",
      reason: rejectionReason(["miao-plugin"], [])!, identity: "fixture" }] as const;
    await put(archive, archived, "export const groupRank = false\n");
    expect(await stageLegacyPanelRankConfig(archive, stage, entries)).toEqual({ active: true, deferred: false });
    expect(Bun.YAML.parse(await readFile(join(stage, "config/panel-rank.yaml"), "utf8"))).toEqual({
      gsDefault: false, srDefault: false, gsLimit: 15, srLimit: 15, legacyGroupStatus: true,
    });
    await put(archive, archived, "export const groupRank = Boolean(someState)\nexport const rankNumber = 24\n");
    const deferred = join(root, "deferred");
    expect(await stageLegacyPanelRankConfig(archive, deferred, entries)).toEqual({ active: false, deferred: true });
    await expect(lstat(join(deferred, "config/panel-rank.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
