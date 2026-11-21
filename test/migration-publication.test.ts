import { afterEach, expect, test } from "bun:test";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockFile, managedHostLockPath, managedStartupLockPath } from "../lib/file-lock.ts";
import { move, writeJournal } from "../lib/filesystem-transaction.ts";
import { publishMigrationPayload, recoverMigrationPublicationForStartup } from "../lib/migration-publication.ts";

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

async function assertState(root: string) {
  for (const [path, contents] of Object.entries(files)) expect(await readFile(join(root, path), "utf8")).toBe(contents);
}

async function assertEmptyState(root: string) {
  for (const path of paths) await expect(lstat(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
}

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

test.skipIf(!Bun.which("git") || process.platform === "win32")("launcher recovers after a real process death before initialization", async () => {
  const { root, stage } = await setup();
  const apply = new URL("../lib/migration-publication.ts", import.meta.url).href;
  const code = `
    import { publishMigrationPayload } from ${JSON.stringify(apply)};
    await publishMigrationPayload(${JSON.stringify(root)}, ${JSON.stringify(stage)}, async () => {
      process.kill(process.pid, "SIGKILL");
    });
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(137);
  await put(root, "scripts/startup.ts", `
    import { readdir } from "node:fs/promises";
    const names = await readdir(".");
    if (["backup", "config", "data"].some(name => names.includes(name))) process.exit(7);
  `);
  await symlink(fileURLToPath(new URL("../lib/", import.meta.url)), join(root, "lib"), "dir");
  await copyFile(new URL("../scripts/launcher.ts", import.meta.url), join(root, "scripts", "launcher.ts"));
  const launcher = Bun.spawn([process.execPath, "--no-env-file", "scripts/launcher.ts", "init"], {
    cwd: root, stdout: "ignore", stderr: "inherit",
  });
  expect(await launcher.exited).toBe(0);
  await assertEmptyState(root);
  await assertState(stage);
  expect((await publishMigrationPayload(root, stage)).status).toBe("published");
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
