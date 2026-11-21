import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageLegacyPluginBackup } from "../lib/plugins/legacy-backup-stage.ts";
import { planMigration } from "../lib/plugins/migration-plan.ts";

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

async function put(file: string, contents: string, mode?: number) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents, mode === undefined ? undefined : { mode });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-plugin-stage-test-"));
  fixture = root;
  const source = join(root, "source");
  const target = join(root, "target");
  const staging = join(root, "staging");
  await mkdir(staging);
  await put(join(target, "plugins/genshin/package.json"), '{"name":"@lotus-yunzai/genshin"}');
  for (const args of [["init"], ["add", "plugins"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]]) {
    const child = Bun.spawnSync(["git", ...args], { cwd: target, stdout: "ignore", stderr: "ignore" });
    expect(child.exitCode).toBe(0);
  }
  const denied = join(source, "plugins/genshin");
  const secrets = join(denied, "config/settings.yaml");
  await put(join(denied, "package.json"), '{"name":"yunzai-genshin"}');
  await put(secrets, "mode: existing\r\n", 0o640);
  await chmod(dirname(secrets), 0o750);
  await put(join(source, "plugins/compatible/index.js"), "throw new Error('fixture must not run')");
  await put(join(root, "outside.yaml"), "outside: true\n");
  await symlink(join(root, "outside.yaml"), join(denied, "external.yaml"));
  return { root, source, target, staging, denied, secrets };
}

test.skipIf(!Bun.which("git"))("stages policy denials and private data, preserves modes, and repeats without overwriting", async () => {
  const { root, source, target, staging, denied, secrets } = await setup();
  const plan = await planMigration(source, target);
  const archive = join(staging, "backup/plugins");
  expect(await stageLegacyPluginBackup(plan, staging)).toEqual({ status: "published", archived: 1, directory: archive });
  expect((await readdir(archive)).sort()).toEqual(["genshin"]);
  const copied = join(archive, "genshin/config/settings.yaml");
  expect(await readFile(copied, "utf8")).toBe("mode: existing\r\n");
  expect((await stat(copied)).mode & 0o7777).toBe((await stat(secrets)).mode & 0o7777);
  expect((await stat(dirname(copied))).mode & 0o7777).toBe((await stat(dirname(secrets))).mode & 0o7777);
  expect(await readlink(join(archive, "genshin/external.yaml"))).toBe(join(root, "outside.yaml"));
  expect(await readFile(join(denied, "package.json"), "utf8")).toBe('{"name":"yunzai-genshin"}');
  expect(await readFile(join(source, "plugins/compatible/index.js"), "utf8")).toContain("must not run");
  const inode = (await stat(copied)).ino;
  expect(await stageLegacyPluginBackup(plan, staging)).toEqual({ status: "already-present", archived: 1, directory: archive });
  expect((await stat(copied)).ino).toBe(inode);
  await writeFile(copied, "mode: conflict\r\n");
  await expect(stageLegacyPluginBackup(plan, staging)).rejects.toThrow("暂存归档已存在且内容不同");
  expect(await readFile(copied, "utf8")).toBe("mode: conflict\r\n");
});

test.skipIf(!Bun.which("git"))("revalidates policy identity, rejects real target use and does not traverse a backup link", async () => {
  const { root, source, target, staging, denied } = await setup();
  const plan = await planMigration(source, target);
  await expect(stageLegacyPluginBackup(plan, target)).rejects.toThrow("须与新旧安装独立");
  await writeFile(join(denied, "package.json"), '{"name":"kissnavel/genshin"}');
  await expect(stageLegacyPluginBackup(plan, staging)).rejects.toThrow("请重新预检");
  await expect(lstat(join(staging, "backup"))).rejects.toMatchObject({ code: "ENOENT" });
  const latest = await planMigration(source, target);
  await symlink(root, join(staging, "backup"));
  await expect(stageLegacyPluginBackup(latest, staging)).rejects.toThrow("backup 必须为实体目录");
  expect(await readlink(join(staging, "backup"))).toBe(root);
  await expect(lstat(join(root, "plugins"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(!Bun.which("git") || !Bun.which("mkfifo"))("discards interrupted copies before publishing and can retry", async () => {
  const { source, target, staging, denied, secrets } = await setup();
  const fifo = join(denied, "z-not-a-file");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const plan = await planMigration(source, target);
  await expect(stageLegacyPluginBackup(plan, staging)).rejects.toThrow("特殊文件");
  expect(await readdir(join(staging, "backup"))).toEqual([]);
  expect(await readFile(secrets, "utf8")).toBe("mode: existing\r\n");
  await rm(fifo);
  const backup = join(staging, "backup");
  await put(join(backup, ".lotus-plugins-interrupted", "plugins/genshin/config/copy.part"), "incomplete");
  expect((await stageLegacyPluginBackup(plan, staging)).status).toBe("published");
  expect(await readFile(join(backup, "plugins/genshin/config/settings.yaml"), "utf8")).toBe("mode: existing\r\n");
  expect(await readFile(join(backup, ".lotus-plugins-interrupted/plugins/genshin/config/copy.part"), "utf8")).toBe("incomplete");
});
