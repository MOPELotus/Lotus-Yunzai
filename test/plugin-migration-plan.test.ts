import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planLegacyPlugins, planMigration } from "../lib/plugins/migration-plan.ts";

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "lotus-old-plugin-plan-test-"));
  fixture = root;
  return root;
}

async function put(root: string, path: string, contents: string | Uint8Array) {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
}

test("classifies policy denials, known protocol candidates, duplicates and target paths without executing plugins", async () => {
  const root = await createFixture();
  const oldEntry = "throw new Error('the migration scanner must not import plugin code');";
  await put(root, "plugins/Miao-Fork/package.json", JSON.stringify({
    name: "custom-miao", repository: "https://github.com/qsyhh/miao-plugin",
  }));
  await put(root, "plugins/Miao-Fork/index.js", oldEntry);
  await put(root, "plugins/xhh-tl/package.json", '{"lotusYunzai":{"games":["wuwa"]}}');
  await put(root, "plugins/Waves-Fork/package.json", '{"lotusYunzai":{"games":["鸣潮"]}}');
  await put(root, "plugins/QQBot-Alias/package.json", '{"repository":{"url":"https://git.trss.me/Yunzai-QQBot-Plugin"}}');
  await put(root, "plugins/SnowLuma/index.js", oldEntry);
  await put(root, "plugins/custom-A/package.json", '{"name":"shared-plugin"}');
  await put(root, "plugins/custom-A/index.js", oldEntry);
  await put(root, "plugins/custom-B/package.json", '{"name":"shared-plugin"}');
  await put(root, "plugins/custom-B/index.js", oldEntry);
  await put(root, "plugins/kit-copy/package.json", '{"name":"@lotus-yunzai/system"}');
  await put(root, "plugins/genshin/package.json", '{"name":"yunzai-genshin"}');
  await put(root, "plugins/group/package.json", '{"name":"local-group"}');
  await put(root, "plugins/media/package.json", "{invalid");
  await put(root, "plugins/system/package.json", '{"name":"@lotus-yunzai/system"}');
  await put(root, "plugins/system/.git", "gitdir: ../ignored-metadata");
  await put(root, "plugins/zzz/index.js", oldEntry);
  await put(root, "plugins/bad/package.json", "{invalid");
  await put(root, "plugins/calendar-plugin/package.json", '{"name":"calendar-plugin"}');
  await put(root, "plugins/calendar-plugin/index.js", oldEntry);
  const protectedPaths = new Set(["plugins/genshin", "plugins/group", "plugins/media", "plugins/system", "plugins/zzz"]);
  const plan = await planLegacyPlugins(root, protectedPaths);

  expect(plan).toEqual([
    { path: "plugins/bad", status: "scan-error", reason: expect.any(String) },
    { path: "plugins/calendar-plugin", status: "retain" },
    { path: "plugins/custom-A", status: "retain" },
    { path: "plugins/custom-B", status: "review", reason: expect.stringContaining("plugins/custom-A") },
    { path: "plugins/genshin", status: "archive", kind: "directory", identity: expect.stringMatching(/^[0-9a-f]{64}$/u), reason: expect.stringContaining("genshin 和 starrail") },
    { path: "plugins/group", status: "review", reason: expect.stringContaining("占用目标内置目录") },
    { path: "plugins/kit-copy", status: "review", reason: expect.stringContaining("plugins/system") },
    { path: "plugins/media", status: "scan-error", reason: expect.any(String) },
    { path: "plugins/Miao-Fork", status: "archive", kind: "directory", identity: expect.stringMatching(/^[0-9a-f]{64}$/u), reason: expect.stringContaining("genshin 和 starrail") },
    { path: "plugins/QQBot-Alias", status: "protocol-candidate", protocol: "qqbot" },
    { path: "plugins/SnowLuma", status: "retain" },
    { path: "plugins/system", status: "built-in" },
    { path: "plugins/Waves-Fork", status: "archive", kind: "directory", identity: expect.stringMatching(/^[0-9a-f]{64}$/u), reason: expect.stringContaining("鸣潮") },
    { path: "plugins/xhh-tl", status: "archive", kind: "directory", identity: expect.stringMatching(/^[0-9a-f]{64}$/u), reason: expect.stringContaining("旧插件功能已归并") },
    { path: "plugins/zzz", status: "review", reason: expect.stringContaining("占用目标内置目录") },
  ]);
  expect(await planLegacyPlugins(root, protectedPaths)).toEqual(plan);
  expect(await readFile(join(root, "plugins/Miao-Fork/index.js"), "utf8")).toBe(oldEntry);
  expect(await lstat(join(root, "backup")).catch(error => error.code)).toBe("ENOENT");
});

test.skipIf(!Bun.which("git"))("uses local Git remotes for forks and leaves externally linked metadata untouched", async () => {
  const root = await createFixture();
  await put(root, "plugins/cloned/.git/config", '[remote "origin"]\nurl = git@gitee.com:mirror/miao-plugin.git\n');
  await put(root, "plugins/linked-git/.git", "gitdir: ../../outside");
  await put(root, "plugins/linked-miao/.git", "gitdir: ../../outside");
  await put(root, "plugins/linked-miao/package.json", '{"name":"miao-plugin"}');
  const plan = await planLegacyPlugins(root, new Set());
  expect(plan).toEqual([
    { path: "plugins/cloned", status: "archive", kind: "directory", identity: expect.stringMatching(/^[0-9a-f]{64}$/u), reason: expect.stringContaining("genshin") },
    { path: "plugins/linked-git", status: "scan-error", reason: expect.any(String) },
    { path: "plugins/linked-miao", status: "archive", kind: "directory", identity: expect.stringMatching(/^[0-9a-f]{64}$/u), reason: expect.stringContaining("genshin") },
  ]);
});

test("keeps unknown scripts in mixed directories and never traverses links or escaped entries", async () => {
  const root = await createFixture();
  await put(root, "external/index.js", "throw new Error('not copied');");
  await put(root, "external/package.json", '{"name":"miao-plugin"}');
  await put(root, "plugins/example/keep.js", "throw new Error('keep me');");
  await put(root, "plugins/example/apps/keep.js", "throw new Error('keep me too');");
  await put(root, "plugins/example/tasks.json", "[]");
  await put(root, "plugins/escaped/package.json", '{"name":"escaped","lotusYunzai":{"entry":"../../external/index.js"}}');
  await mkdir(join(root, "plugins/linked-manifest"));
  await symlink(join(root, "external"), join(root, "plugins/miao-plugin"), "dir");
  await symlink(join(root, "external/package.json"), join(root, "plugins/linked-manifest/package.json"));
  await symlink(join(root, "external/index.js"), join(root, "plugins/link.js"));
  expect(await planLegacyPlugins(root, new Set())).toEqual([
    { path: "plugins/escaped", status: "scan-error", reason: expect.any(String) },
    { path: "plugins/example", status: "retain" },
    { path: "plugins/link.js", status: "review", reason: expect.any(String) },
    { path: "plugins/linked-manifest", status: "scan-error", reason: expect.any(String) },
    { path: "plugins/miao-plugin", status: "review", reason: expect.any(String) },
  ]);
  expect(await readFile(join(root, "plugins/example/tasks.json"), "utf8")).toBe("[]");
});

test("does not classify customized same-name host directories as old built-ins", async () => {
  const root = await createFixture();
  for (const path of ["install.js", "restart.js", "sendLog.js", "update.js", "version.js"]) {
    await put(root, `plugins/other/${path}`, "export const localExtension = true;\n");
  }
  for (const path of ["add.js", "botOperate.js", "disablePrivate.js", "friend.js", "invite.js", "master.js", "quit.js", "recallReply.js", "status.js"]) {
    await put(root, `plugins/system/${path}`, "export const localExtension = true;\n");
  }
  expect(await planLegacyPlugins(root, new Set(["plugins/system"]))).toEqual([
    { path: "plugins/other", status: "retain" },
    { path: "plugins/system", status: "review", reason: expect.stringContaining("占用目标内置目录") },
  ]);
});

test("reports oversized metadata and scripts without reading their contents", async () => {
  const root = await createFixture();
  await put(root, "plugins/big-package/package.json", "");
  await put(root, "plugins/big-script.js", "");
  await put(root, "plugins/large-git/.git/config", "");
  await truncate(join(root, "plugins/big-package/package.json"), 20 * 1024 * 1024);
  await truncate(join(root, "plugins/big-script.js"), 20 * 1024 * 1024);
  await truncate(join(root, "plugins/large-git/.git/config"), 20 * 1024 * 1024);
  const plan = await planLegacyPlugins(root, new Set());
  expect(plan).toEqual(["big-package", "big-script.js", "large-git"].map(name => ({
    path: `plugins/${name}`, status: "scan-error", reason: expect.stringContaining("大小上限"),
  })));
});

test.skipIf(!Bun.which("git"))("plans against the tracked target, refuses nesting and resolves links before scanning", async () => {
  const root = await createFixture();
  const target = join(root, "target");
  const legacy = join(root, "legacy");
  await put(target, "plugins/genshin/package.json", '{"name":"@lotus-yunzai/genshin"}');
  await put(legacy, "plugins/genshin/index.js", "throw new Error('must never run')");
  for (const args of [["init"], ["add", "plugins"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]]) {
    const child = Bun.spawnSync(["git", ...args], { cwd: target, stdout: "ignore", stderr: "ignore" });
    expect(child.exitCode).toBe(0);
  }
  await symlink(target, join(root, "linked-target"), "dir");
  await expect(planMigration(target, target)).rejects.toThrow("相同或互相包含");
  await expect(planMigration(join(root, "linked-target"), target)).rejects.toThrow("相同或互相包含");
  await expect(planMigration(root, target)).rejects.toThrow("相同或互相包含");
  await expect(planMigration(join(target, "plugins"), target)).rejects.toThrow("相同或互相包含");
  const plan = await planMigration(legacy, target);
  expect(plan).toMatchObject({ version: 1, mode: "dry-run", scope: "legacy-plugins", source: legacy, target, plugins: [
    { path: "plugins/genshin", status: "review", reason: expect.stringContaining("占用目标内置目录") },
  ] });
  expect(await lstat(join(legacy, "backup")).catch(error => error.code)).toBe("ENOENT");
});
