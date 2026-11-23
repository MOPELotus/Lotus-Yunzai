import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectPanelTrialDisplay } from "../lib/migration-panel-trial-display.ts";
import { layoutTrialDamageTitles, readPanelTrialDisplay, trialDamageTitleLines } from "../lib/panel-trial-display.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
import { stageMigration } from "../scripts/migrate-stage.ts";

async function put(root: string, path: string, contents: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}

test("按旧试算规则处理长标题，换行仅在标题超出旧阈值时按当前字宽排布", () => {
  const full = "  " + "伤".repeat(18) + "(11)害数 ";
  expect(trialDamageTitleLines(full, 0)).toEqual([full]);
  expect(trialDamageTitleLines(full, 1)).toEqual(["伤".repeat(18) + "(11)..."]);
  expect(trialDamageTitleLines(" # 范围 ", 1)).toEqual(["# 范围"]);
  expect(trialDamageTitleLines(full, 2)).toEqual(["伤".repeat(18) + "(11)", "害数"]);
  const fit = (line: string) => line.length <= 12;
  expect(layoutTrialDamageTitles([{ title: "伤".repeat(18) }], 40, 2, fit).height).toBe(40);
  expect(layoutTrialDamageTitles([{ title: full }, { title: "短伤" }], 40, 2, fit)).toEqual({
    rows: [{ lines: ["伤".repeat(12), "伤".repeat(6) + "(11)害数"], top: 0, height: 58 },
      { lines: ["短伤"], top: 58, height: 40 }],
    height: 98,
  });
});

test.skipIf(!Bun.which("git"))("迁移 Ark 显示设置并由现行宿主读取，已有设置优先", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trial-settings-"));
  try {
    const source = join(root, "old"), target = join(root, "new");
    const script = [
      "/* export const profileChangeDiff = true */",
      "export const profileChangeDiff = false;",
      "export const DealLongDmgTitle = 2; // 用户设为换行",
      "throw new Error('迁移不得执行旧 JS')",
    ].join("\r\n");
    await put(source, "plugins/renamed-ark/package.json", '{"name":"ark-plugin"}');
    await put(source, "plugins/renamed-ark/config/cfg.js", script);
    await put(source, "config/global.yaml", "panel_trial: {show_difference: true}\n");
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    await put(target, "plugins/.fixture", "fixture");
    for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
    }
    const staged = await stageMigration(source, target);
    expect(staged.globalConfig.sections).toContain("panel_trial");
    expect(staged.globalConfig.deferredPanelTrial).toBeUndefined();
    expect(await readPanelTrialDisplay(Bun.pathToFileURL(staged.state.directory + "/"))).toEqual({ showDifference: true, longTitle: 2 });
    expect(await Bun.file(join(source, "plugins/renamed-ark/config/cfg.js")).text()).toBe(script);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("归档的值逐项保留 false 和 0，错误表达式只记录字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-ark-settings-archive-"));
  const archive = { directory, plugins: [{ path: "plugins/ark-plugin", status: "archive", kind: "directory",
    reason: rejectionReason(["ark-plugin"], [])!, identity: "fixture" }] } as const;
  try {
    await put(directory, "ark-plugin/config/cfg.js", "export const profileChangeDiff = false;\nexport const DealLongDmgTitle = 0;\n");
    expect(await projectPanelTrialDisplay({}, archive)).toEqual({ config: { show_difference: false, long_title: 0 }, deferred: [] });
    await put(directory, "ark-plugin/config/cfg.js", "export const profileChangeDiff = !true;\nexport const DealLongDmgTitle = 1;\n");
    expect(await projectPanelTrialDisplay({}, archive)).toEqual({ config: { long_title: 1 },
      deferred: [{ field: "profileChangeDiff", reason: "invalid-setting" }] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("已迁移的目标可读取未导入的 Ark 值，面板配置逐字段优先", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-ark-settings-existing-"));
  const root = Bun.pathToFileURL(directory + "/");
  try {
    await put(directory, "backup/plugins/ark-plugin/config/cfg.js",
      "export const profileChangeDiff = false;\nexport const DealLongDmgTitle = 0;\n");
    expect(await readPanelTrialDisplay(root)).toEqual({ showDifference: false, longTitle: 0 });
    await put(directory, "config/global.yaml", "panel_trial: {show_difference: true}\n");
    expect(await readPanelTrialDisplay(root)).toEqual({ showDifference: true, longTitle: 0 });
    await put(directory, "config/global.yaml", "panel_trial: {show_difference: true, long_title: 1}\n");
    expect(await readPanelTrialDisplay(root)).toEqual({ showDifference: true, longTitle: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
