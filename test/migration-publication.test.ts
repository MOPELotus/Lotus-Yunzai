import { afterEach, expect, test } from "bun:test";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockFile, managedHostLockPath, managedStartupLockPath } from "../lib/file-lock.ts";
import { move, writeJournal } from "../lib/filesystem-transaction.ts";
import { publishMigrationPayload, recoverMigrationPublicationForStartup } from "../lib/migration-publication.ts";
import { linkHostPackages } from "./host-fixture.ts";
import { activateUpdate } from "../lib/update-activation.ts";

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

const files = {
  "backup/plugins/retired/config.yaml": "mode: archive\r\n",
  "config/config/group.yaml": "privateChat: true\r\n",
  "data/srJson/11/22/1.json": '[{"id":"9223372036854775807"}]',
};

async function put(root: string, path: string, contents: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents, { mode: 0o600 });
}

async function setup() {
  const parent = await mkdtemp(join(tmpdir(), "lotus-migration-publish-test-"));
  fixture = parent;
  const root = join(parent, "target");
  const stage = join(parent, "stage");
  const source = join(parent, "source");
  await put(root, "package.json", '{"name":"lotus-yunzai"}');
  await put(root, "plugins/genshin/module.ts", "native Lotus code");
  for (const args of [["init"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]]) {
    const child = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" });
    expect(child.exitCode).toBe(0);
  }
  for (const [path, contents] of Object.entries(files)) {
    await put(stage, path, contents);
    await put(source, path, contents);
  }
  return { parent, root, stage, source };
}

const paths: ("backup" | "config" | "data")[] = ["backup", "config", "data"];
const plugins = ["plugins/extra-plugin", "plugins/extra-script.js"];

async function stagedPlugins(stage: string) {
  await put(stage, "plugins/extra-plugin/index.js", "throw new Error('this fixture is kept, not run');");
  await put(stage, "plugins/extra-script.js", "export default {};");
}

async function inspectPluginParents(root: string) {
  const paths = ["plugins", "plugins/genshin", "plugins/genshin/module.ts"];
  const inode = await Promise.all(paths.map(async path => (await lstat(join(root, path))).ino));
  return { inode, native: await readFile(join(root, "plugins/genshin/module.ts"), "utf8") };
}


async function assertState(root: string) {
  for (const [path, contents] of Object.entries(files)) expect(await readFile(join(root, path), "utf8")).toBe(contents);
}

async function assertEmptyState(root: string) {
  for (const path of paths) await expect(lstat(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
}

test.skipIf(process.platform !== "linux" || !Bun.which("git") || !Bun.which("sync"))("publication-syncfs-failure", async () => {
  const { parent, root, stage } = await setup();
  const bin = join(parent, "bin"), counter = join(parent, "counter"), realSync = Bun.which("sync")!;
  await mkdir(bin);
  await writeFile(join(bin, "sync"), `#!/bin/sh\nprintf x >> '${counter}'\nif [ "$(wc -c < '${counter}')" -gt 1 ]; then exit 9; fi\nexec '${realSync}' "$@"\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = bin + ":" + previous;
  try {
    await expect(publishMigrationPayload(root, stage)).rejects.toThrow("EIO");
    expect(await readFile(counter, "utf8")).toBe("xx");
    await assertEmptyState(root);
    await assertState(stage);
    await expect(lstat(join(parent, ".target.lotus-migration-pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(parent, ".target.lotus-migration-applied.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  expect((await publishMigrationPayload(root, stage)).status).toBe("published");
  await assertState(root);
});

test.skipIf(process.platform !== "linux" || !Bun.which("git"))("publication-syncfs-unavailable", async () => {
  const { parent, root, stage } = await setup();
  const bin = join(parent, "bin"), counter = join(parent, "counter");
  await mkdir(bin);
  await writeFile(join(bin, "sync"), `#!/bin/sh\nprintf x >> '${counter}'\nexit 64\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = bin + ":" + previous;
  try {
    expect((await publishMigrationPayload(root, stage)).status).toBe("published");
    expect(await readFile(counter, "utf8")).toBe("x");
    await assertState(root);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test.skipIf(!Bun.which("git"))("publishes one staged batch and reuses the same completion receipt", async () => {
  const { root, stage, source } = await setup();
  const rootBefore = await lstat(root);
  const before = await lstat(join(stage, "data"));
  let verified = false;
  expect(await publishMigrationPayload(root, stage, async target => {
    expect(target).toBe(root);
    await assertState(root);
    verified = true;
  })).toEqual({ status: "published", paths });
  expect(verified).toBe(true);
  await assertState(root);
  await assertState(source);
  expect(await readdir(stage)).toEqual([]);
  expect((await lstat(root)).ino).toBe(rootBefore.ino);
  expect((await lstat(join(root, "data"))).ino).toBe(before.ino);
  expect(await readFile(join(root, "plugins/genshin/module.ts"), "utf8")).toBe("native Lotus code");
  expect(await publishMigrationPayload(root, stage)).toEqual({ status: "already-published", paths });
});

test.skipIf(!Bun.which("git"))("rechecks a migration after a managed update using its preserved state directories", async () => {
  const { parent, root, stage } = await setup();
  await stagedPlugins(stage);
  const published = await publishMigrationPayload(root, stage, undefined, plugins);
  const original = await lstat(root);
  const candidate = join(parent, "candidate");
  const cloned = Bun.spawnSync(["git", "clone", "--no-local", "-q", root, candidate], { stdout: "ignore", stderr: "ignore" });
  expect(cloned.exitCode).toBe(0);
  await stagedPlugins(candidate);
  const before = await lstat(join(root, "plugins/extra-script.js"));
  await activateUpdate(root, candidate, assertState);
  expect((await lstat(root)).ino).not.toBe(original.ino);
  expect((await lstat(join(root, "plugins/extra-script.js"))).ino).not.toBe(before.ino);
  expect(await publishMigrationPayload(root, stage, undefined, plugins)).toEqual({ status: "already-published", paths: published.paths });

  await rename(join(root, "data"), join(root, "preserved-data"));
  await put(root, "data/srJson/11/22/1.json", "[]");
  await expect(publishMigrationPayload(root, stage, undefined, plugins)).rejects.toThrow("持久目录已变更");
  expect(await readFile(join(root, "data/srJson/11/22/1.json"), "utf8")).toBe("[]");
});

test.skipIf(!Bun.which("git"))("refuses a running host, an existing startup and a target file collision", async () => {
  const { root, stage } = await setup();
  for (const path of [managedHostLockPath(root), managedStartupLockPath(root)]) {
    const lock = await lockFile(path, "正在占用", 0);
    try {
      await expect(publishMigrationPayload(root, stage)).rejects.toThrow();
      await assertEmptyState(root);
      await assertState(stage);
    } finally {
      lock.close();
    }
  }
  await put(root, "data/untouched", "existing");
  await expect(publishMigrationPayload(root, stage)).rejects.toThrow("已有 data");
  expect(await readFile(join(root, "data/untouched"), "utf8")).toBe("existing");
  await expect(lstat(join(root, "config"))).rejects.toMatchObject({ code: "ENOENT" });
  await assertState(stage);
});

test.skipIf(!Bun.which("git"))("restores the entire staged batch when pre-start verification fails", async () => {
  const { root, stage } = await setup();
  await expect(publishMigrationPayload(root, stage, async () => {
    await assertState(root);
    throw new Error("fixture verification failed");
  })).rejects.toThrow("fixture verification failed");
  await assertEmptyState(root);
  await assertState(stage);
  expect(await recoverMigrationPublicationForStartup(root)).toBe(false);
  expect((await publishMigrationPayload(root, stage)).status).toBe("published");
});

test.skipIf(!Bun.which("git"))("recovers a partial move before startup reads config", async () => {
  const { parent, root, stage } = await setup();
  const snapshot = async (path: string) => {
    const { dev, ino } = await lstat(path);
    return { dev, ino };
  };
  const pending = join(parent, `.${basename(root)}.lotus-migration-pending.json`);
  const entry = { version: 1, committed: false, target: await snapshot(root), stage: { path: stage, ...await snapshot(stage) },
    state: await Promise.all(paths.map(async path => ({ path, ...await snapshot(join(stage, path)) }))) };
  await writeJournal(pending, entry, true);
  await move(join(stage, "config"), join(root, "config"));
  const startup = await lockFile(managedStartupLockPath(root), "启动操作", 0);
  try {
    expect(await recoverMigrationPublicationForStartup(root)).toBe(true);
    await assertEmptyState(root);
    await assertState(stage);
    expect(await recoverMigrationPublicationForStartup(root)).toBe(false);
  } finally {
    startup.close();
  }
  await expect(lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await publishMigrationPayload(root, stage)).status).toBe("published");
});

test.skipIf(!Bun.which("git"))("keeps a committed batch and repairs the receipt after an interruption", async () => {
  const { parent, root, stage } = await setup();
  const snapshot = async (path: string) => {
    const { dev, ino } = await lstat(path);
    return { dev, ino };
  };
  const state = await Promise.all(paths.map(async path => ({ path, ...await snapshot(join(stage, path)) })));
  for (const path of paths) await move(join(stage, path), join(root, path));
  await writeJournal(join(parent, `.${basename(root)}.lotus-migration-pending.json`), {
    version: 1, committed: true, target: await snapshot(root), stage: { path: stage, ...await snapshot(stage) }, state,
  }, true);
  const startup = await lockFile(managedStartupLockPath(root), "启动操作", 0);
  try {
    expect(await recoverMigrationPublicationForStartup(root)).toBe(true);
    await assertState(root);
  } finally {
    startup.close();
  }
  expect(await publishMigrationPayload(root, stage)).toEqual({ status: "already-published", paths });
});

test.skipIf(!Bun.which("git") || process.platform === "win32")("launcher recovers plugins and data after a real process death before initialization", async () => {
  const { root, stage } = await setup();
  await stagedPlugins(stage);
  const native = await inspectPluginParents(root);
  const apply = new URL("../lib/migration-publication.ts", import.meta.url).href;
  const code = `
    import { publishMigrationPayload } from ${JSON.stringify(apply)};
    await publishMigrationPayload(${JSON.stringify(root)}, ${JSON.stringify(stage)}, async () => {
      process.kill(process.pid, "SIGKILL");
    }, ${JSON.stringify(plugins)});
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(137);
  await put(root, "scripts/startup.ts", `
    import { readdir } from "node:fs/promises";
    const names = await readdir(".");
    if (["backup", "config", "data"].some(name => names.includes(name))) process.exit(7);
    if ((await readdir("plugins")).some(name => name !== "genshin")) process.exit(8);
  `);
  await symlink(fileURLToPath(new URL("../lib/", import.meta.url)), join(root, "lib"), "dir");
  await linkHostPackages(root);
  await mkdir(join(root, "i18n"), { recursive: true });
  await copyFile(new URL("../i18n/zh-CN.json", import.meta.url), join(root, "i18n/zh-CN.json"));
  await copyFile(new URL("../scripts/launcher.ts", import.meta.url), join(root, "scripts", "launcher.ts"));
  const launcher = Bun.spawn([process.execPath, "--no-env-file", "scripts/launcher.ts", "init"], {
    cwd: root, stdout: "ignore", stderr: "inherit",
  });
  expect(await launcher.exited).toBe(0);
  await assertEmptyState(root);
  await assertState(stage);
  expect(await inspectPluginParents(root)).toEqual(native);
  expect((await readdir(join(stage, "plugins"))).sort()).toEqual(["extra-plugin", "extra-script.js"]);
  expect((await publishMigrationPayload(root, stage, undefined, plugins)).status).toBe("published");
  expect(await inspectPluginParents(root)).toEqual(native);
  expect(await readFile(join(root, "plugins/extra-script.js"), "utf8")).toBe("export default {};");
  expect(await readFile(join(root, "plugins/extra-plugin/index.js"), "utf8")).toContain("fixture is kept");
  expect(await publishMigrationPayload(root, stage, undefined, plugins)).toMatchObject({ status: "already-published", paths: [...paths, ...plugins] });
  await expect(publishMigrationPayload(root, stage)).rejects.toThrow("核准清单与迁移结果不一致");
});

test.skipIf(!Bun.which("git"))("refuses unvalidated top-level paths and does not touch symlink targets", async () => {
  const { root, stage, source } = await setup();
  await symlink(join(source, "config"), join(stage, "unknown"));
  await expect(publishMigrationPayload(root, stage)).rejects.toThrow("只接受已验证");
  await rm(join(stage, "unknown"));
  await rm(join(stage, "config"), { recursive: true });
  await symlink(join(source, "config"), join(stage, "config"));
  await expect(publishMigrationPayload(root, stage)).rejects.toThrow("须为实体目录");
  await assertEmptyState(root);
  await assertState(source);
});

test.skipIf(!Bun.which("git"))("requires explicit approvals and blocks existing, index and removed tracked paths", async () => {
  const { root, stage } = await setup();
  await stagedPlugins(stage);
  await expect(publishMigrationPayload(root, stage)).rejects.toThrow("暂存与核准清单不一致");
  await expect(publishMigrationPayload(root, stage, undefined, ["plugins/../genshin"])).rejects.toThrow("核准路径无效");
  const stagedScript = join(stage, "plugins/extra-script.js");
  const externalLink = join(stage, "..", "external-hard-link");
  await link(stagedScript, externalLink);
  await expect(publishMigrationPayload(root, stage, undefined, plugins)).rejects.toThrow("无硬链接的普通文件");
  await rm(externalLink);

  await put(root, "plugins/extra-script.js", "keep existing");
  await expect(publishMigrationPayload(root, stage, undefined, plugins)).rejects.toThrow("已有 plugins/extra-script.js");
  expect(await readFile(join(root, "plugins/extra-script.js"), "utf8")).toBe("keep existing");
  expect(Bun.spawnSync(["git", "add", "plugins/extra-script.js"], { cwd: root }).exitCode).toBe(0);
  await rm(join(root, "plugins/extra-script.js"));
  await expect(publishMigrationPayload(root, stage, undefined, plugins)).rejects.toThrow("Git 跟踪路径冲突：plugins/extra-script.js");
  expect(Bun.spawnSync(["git", "reset", "--", "plugins/extra-script.js"], { cwd: root, stdout: "ignore" }).exitCode).toBe(0);

  await rm(join(root, "plugins/genshin"), { recursive: true });
  await put(stage, "plugins/genshin/index.js", "unrelated old code");
  await expect(publishMigrationPayload(root, stage, undefined, [...plugins, "plugins/genshin"])).rejects.toThrow("Git 跟踪路径冲突：plugins/genshin");
  await assertEmptyState(root);
  await assertState(stage);
});

test.skipIf(!Bun.which("git"))("never follows a replaced plugin parent during publication or recovery", async () => {
  const { parent, root, stage } = await setup();
  await stagedPlugins(stage);
  const displaced = join(parent, "displaced");
  await rename(join(root, "plugins"), displaced);
  await symlink(displaced, join(root, "plugins"));
  await expect(publishMigrationPayload(root, stage, undefined, plugins)).rejects.toThrow("目标插件根须为实体目录");
  await assertEmptyState(root);
  await rm(join(root, "plugins"));
  await rename(displaced, join(root, "plugins"));
  const native = await inspectPluginParents(root);

  const snapshot = async (path: string) => {
    const { dev, ino } = await lstat(path);
    return { dev, ino };
  };
  const pending = join(parent, `.${basename(root)}.lotus-migration-pending.json`);
  const entry = { version: 1, committed: false, target: await snapshot(root), stage: { path: stage, ...await snapshot(stage) },
    pluginParents: { target: await snapshot(join(root, "plugins")), stage: await snapshot(join(stage, "plugins")) },
    state: await Promise.all([...paths, ...plugins].map(async path => ({
      path, ...await snapshot(join(stage, path)), ...(path.endsWith(".js") && { kind: "file" }),
    }))) };
  await writeJournal(pending, entry, true);
  const temporary = pending + "." + crypto.randomUUID();
  await link(pending, temporary);
  await move(join(stage, "config"), join(root, "config"));
  await move(join(stage, "plugins/extra-script.js"), join(root, "plugins/extra-script.js"));

  const moved = join(parent, "moved-stage-plugins");
  await rename(join(stage, "plugins"), moved);
  await symlink(moved, join(stage, "plugins"));
  const startup = await lockFile(managedStartupLockPath(root), "启动操作", 0);
  try {
    await expect(recoverMigrationPublicationForStartup(root)).rejects.toThrow("父目录已变更");
    expect(await readFile(join(root, "plugins/extra-script.js"), "utf8")).toBe("export default {};");
    await rm(join(stage, "plugins"));
    await rename(moved, join(stage, "plugins"));
    expect(await recoverMigrationPublicationForStartup(root)).toBe(true);
  } finally {
    startup.close();
  }
  expect(await inspectPluginParents(root)).toEqual(native);
  await assertEmptyState(root);
  await assertState(stage);
  expect(await readFile(join(stage, "plugins/extra-script.js"), "utf8")).toBe("export default {};");
  await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
});
