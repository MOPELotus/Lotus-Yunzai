import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageLegacyZzzRecallConfig } from "../lib/migration-zzz-recall.ts";
import { readLegacyZzzUpdateNotice } from "../lib/migration-zzz-update-notice.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

async function put(root: string, path: string, contents: string) {
  const filename = join(root, path);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, contents, { mode: 0o600 });
}

test.skipIf(!Bun.which("git"))("迁移从旧绝区零配置保留显式关闭、默认面板设置和旧目录归档", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-migration-zzz-recall-"));
  const source = join(root, "old"), target = join(root, "new");
  const plugin = "plugins/renamed-zzz";
  const original = "# 用户覆盖\nrecallMsg: 0\nfeature: retained\nupdate:\n  autoCheck: true\n  cron: 0 0/10 * * * ?\n";
  try {
    await put(source, `${plugin}/package.json`, '{"name":"zzz-plugin"}');
    await put(source, `${plugin}/defSet/config.yaml`, "recallMsg: 100\n");
    await put(source, `${plugin}/config/config.yaml`, original);
    await put(source, `${plugin}/defSet/panel.yaml`, "roleInterval: 3000\nbuttons: false\n");
    await put(source, `${plugin}/config/panel.yaml`, "roleInterval: 310\ninterval: 60\n");
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    await put(target, "plugins/.fixture", "fixture");
    for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
    }
    const zzzRecall = { active: true, deferred: false };
    const updateNotice = { settings: { update_notice: true, update_notice_cron: "0 0/10 * * * ?" }, deferred: false };
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "published", zzzRecall, updateNotice });
    expect(Bun.YAML.parse(await readFile(join(target, "config/config/bot.yaml"), "utf8"))).toEqual({
      update_time: 0, ...updateNotice.settings,
    });
    const saved = join(target, "config/zzz-panel.yaml");
    expect(Bun.YAML.parse(await readFile(saved, "utf8"))).toEqual({ roleInterval: 310, buttons: false, interval: 60, recallMsg: 0 });
    expect((await lstat(saved)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(target, "backup", `${plugin}/config/config.yaml`), "utf8")).toBe(original);
    expect(await readFile(join(source, `${plugin}/config/config.yaml`), "utf8")).toBe(original);
    await writeFile(saved, "roleInterval: 310\nrecallMsg: 30\n");
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published", zzzRecall });
    expect(await readFile(saved, "utf8")).toBe("roleInterval: 310\nrecallMsg: 30\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("迁移继承旧绝区零 defSet 撤回时间并标记无法识别的值", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-stage-zzz-recall-"));
  const archive = join(root, "archive");
  const entries = [{ path: "plugins/ZZZ-Plugin", status: "archive", kind: "directory",
    identity: "fixture", reason: rejectionReason(["zzz-plugin"], [])! }] as const;
  try {
    await put(archive, "ZZZ-Plugin/defSet/config.yaml", "recallMsg: '130'\n");
    await put(archive, "ZZZ-Plugin/config/config.yaml", "unrelated: true\n");
    const stage = join(root, "stage");
    expect(await stageLegacyZzzRecallConfig(archive, stage, entries)).toEqual({ active: true, deferred: false });
    expect(Bun.YAML.parse(await readFile(join(stage, "config/zzz-panel.yaml"), "utf8"))).toEqual({ recallMsg: 120 });
    await put(archive, "ZZZ-Plugin/config/config.yaml", "recallMsg: []\n");
    const deferred = join(root, "deferred");
    expect(await stageLegacyZzzRecallConfig(archive, deferred, entries)).toEqual({ active: false, deferred: true });
    await expect(lstat(join(deferred, "config/zzz-panel.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("迁移更新通知尊重显式关闭并把无效周期留待复核", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-stage-zzz-update-notice-"));
  const entries = [{ path: "plugins/ZZZ-Plugin", status: "archive", kind: "directory",
    identity: "fixture", reason: rejectionReason(["zzz-plugin"], [])! }] as const;
  try {
    await put(root, "ZZZ-Plugin/defSet/config.yaml", "update: { autoCheck: true }\n");
    expect(await readLegacyZzzUpdateNotice(root, entries)).toEqual({ deferred: false });
    await put(root, "ZZZ-Plugin/config/config.yaml", "update: { autoCheck: false }\n");
    expect(await readLegacyZzzUpdateNotice(root, entries)).toEqual({ settings: { update_notice: false }, deferred: false });
    await put(root, "ZZZ-Plugin/config/config.yaml", 'update: { autoCheck: true, cron: "0 32 * * *" }\n');
    expect(await readLegacyZzzUpdateNotice(root, entries)).toEqual({ deferred: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
