import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { challengeReminderConfigFile, challengeReminderWindow, createZzzChallengeReminderStore } from "../plugins/zzz/challenge-reminder-store.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

async function put(root: string, path: string, contents: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents, { mode: 0o600 });
}

test.skipIf(!Bun.which("git"))("绝区零挑战提醒从拒载归档迁入运行配置并保留关闭状态、边界与后续更改", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-migration-zzz-remind-"));
  try {
    const source = join(root, "old");
    const target = join(root, "new");
    const plugin = "plugins/renamed-zzz";
    const bundled = "enable: true\nabyssCheckLevel: 5\ndeadlyStars: 9\nglobalRemindTime: 每日20时\n";
    const local = "enable: false\nabyssCheckLevel: 0\nglobalRemindTime: 每周日23时50分\n";
    await put(source, plugin + "/package.json", '{"name":"zzz-plugin"}');
    await put(source, plugin + "/defSet/remind.yaml", bundled);
    await put(source, plugin + "/config/remind.yaml", local);
    await put(source, challengeReminderConfigFile, "deadlyStars: 8\n");
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    await put(target, "plugins/.fixture", "fixture");
    for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
    }
    const modern = join(target, challengeReminderConfigFile);
    const legacy = join(target, "plugins/ZZZ-Plugin/config/remind.yaml");
    const untrusted = join(root, "outside.yaml");
    await writeFile(untrusted, local);
    await rm(join(source, plugin, "config/remind.yaml"));
    await symlink(untrusted, join(source, plugin, "config/remind.yaml"));
    await expect(migrateInstallation(source, target)).rejects.toThrow("迁移源文件无法安全读取");
    await expect(lstat(modern)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(join(source, plugin, "config/remind.yaml"));
    await put(source, plugin + "/config/remind.yaml", local);

    expect(await migrateInstallation(source, target)).toMatchObject({
      status: "published", zzzChallengeReminder: { fields: ["enable", "abyssCheckLevel", "deadlyStars", "remindTime"] },
    });
    expect((await lstat(modern)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(target, "backup", plugin, "config/remind.yaml"), "utf8")).toBe(local);
    expect(await readFile(join(source, plugin, "config/remind.yaml"), "utf8")).toBe(local);
    await expect(lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });

    let panel: Record<string, string> = {};
    const redis = { hGetAll: async () => panel } as Parameters<typeof createZzzChallengeReminderStore>[0];
    const store = createZzzChallengeReminderStore(redis, legacy, modern);
    const migrated = { enable: false, abyssCheckLevel: 0, deadlyStars: 8, remindTime: "每周日23时50分" };
    expect(await store.global()).toEqual(migrated);
    expect(challengeReminderWindow(migrated.remindTime, Date.parse("2026-11-22T15:49:59Z"))).toBeUndefined();
    expect(challengeReminderWindow(migrated.remindTime, Date.parse("2026-11-22T15:50:00Z"))).toBe("2026-11-22");
    expect(challengeReminderWindow(migrated.remindTime, Date.parse("2026-11-22T16:00:00Z"))).toBeUndefined();
    panel = { enable: "1", deadlyStars: "0" };
    expect(await store.global()).toEqual({ ...migrated, enable: true, deadlyStars: 0 });
    await put(target, challengeReminderConfigFile, "enable: false\nabyssCheckLevel: 6\ndeadlyStars: 9\nremindTime: 每日0时\n");
    const edited = await readFile(modern, "utf8");
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published" });
    expect(await readFile(modern, "utf8")).toBe(edited);
    panel = {};
    expect(await store.global()).toEqual({ enable: false, abyssCheckLevel: 6, deadlyStars: 9, remindTime: "每日0时" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
