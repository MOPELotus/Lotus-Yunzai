import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareUpdate, type ReadyBatchUpdate, type ReadyUpdate } from "../lib/update-preflight.ts";
import { stageUpdate } from "../lib/update-staging.ts";
import { verifyUpdateHealth } from "../lib/update-health.ts";

const noGit = !Bun.which("git");
const runtimePaths = [
  "config/fixture.txt", "data/fixture.txt", "logs/fixture.txt", "node_modules/fixture.txt", "panel/dist/fixture.txt",
] as const;

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", ...args,
  ], {
    cwd: directory,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.exitCode !== 0) throw new Error(`Git 夹具命令失败（${args[0]}）。\n${result.stderr.toString()}`);
  return result.stdout.toString().trimEnd();
}

async function writeFiles(root: string, files: Record<string, string>) {
  await Promise.all(Object.entries(files).map(async ([name, text]) => {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }));
}

async function makeRepository(temporary: string, name: string, files: Record<string, string>) {
  const origin = join(temporary, `${name}.git`);
  const writer = join(temporary, `${name}-writer`);
  git(temporary, "init", "--bare", "--quiet", "--initial-branch=main", origin);
  git(temporary, "init", "--quiet", "--initial-branch=main", writer);
  await writeFiles(writer, files);
  return {
    writer,
    publish(subject: string) {
      git(writer, "add", "--all");
      git(writer, "commit", "--quiet", "-m", subject);
      git(writer, "push", "--quiet", origin, "main");
      return git(writer, "rev-parse", "HEAD");
    },
    checkout(path: string) {
      git(temporary, "clone", "--quiet", "--no-local", origin, path);
    },
  };
}

async function fixture(run: (workspace: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-update-staging-"));
  try {
    await run(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const bootstrap = `
  import { mkdir } from "node:fs/promises";
  import { dirname } from "node:path";
  for (const path of ${JSON.stringify(runtimePaths)}) {
    if (await Bun.file(path).exists()) throw new Error("active fixture leaked into staging");
  }
  const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], {
    stdout: "inherit", stderr: "inherit",
  });
  if (await install.exited !== 0) process.exit(1);
  for (const path of ${JSON.stringify(runtimePaths)}) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, "staged " + path);
  }
  await Bun.write("bootstrap-marker.txt", "frozen install completed");
`;

const typecheck = `
  import { strictEqual } from "node:assert";
  import { revision } from "../app.ts";
  import { installed } from "@fixture/local-dependency";
  strictEqual(installed, "workspace package");
  strictEqual(await Bun.file("bootstrap-marker.txt").text(), "frozen install completed");
  await Bun.write("typecheck-marker.txt", revision);
`;

async function fixtureHost(temporary: string) {
  const repo = await makeRepository(temporary, "host", {
    ".gitignore": "/node_modules/\n/config/\n/data/\n/logs/\n/panel/dist/\n/plugins/\n",
    "package.json": JSON.stringify({
      name: "lotus-yunzai", private: true, type: "module", packageManager: `bun@${Bun.version}`,
      workspaces: ["packages/*"], dependencies: { "@fixture/local-dependency": "workspace:*" },
      scripts: { bootstrap: "bun scripts/bootstrap.ts", typecheck: "bun scripts/typecheck.ts" },
    }),
    "app.ts": 'export const revision = "active host";\n',
    "scripts/bootstrap.ts": bootstrap,
    "scripts/typecheck.ts": typecheck,
    "packages/local-dependency/package.json": JSON.stringify({
      name: "@fixture/local-dependency", version: "1.0.0", type: "module", exports: "./index.ts",
    }),
    "packages/local-dependency/index.ts": 'export const installed = "workspace package";\n',
  });
  const lock = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], {
    cwd: repo.writer,
    env: { PATH: process.env.PATH, BUN_INSTALL_CACHE_DIR: join(temporary, "fixture-bun-cache") },
  });
  if (lock.exitCode !== 0) throw new Error(`无法生成夹具锁文件。\n${lock.stderr.toString()}`);
  const baseline = repo.publish("Fixture active host");
  const active = join(temporary, "active");
  repo.checkout(active);
  await writeFiles(active, Object.fromEntries(runtimePaths.map((path) => [path, `active ${path}`])));
  const stagingParent = join(temporary, "staging");
  await mkdir(stagingParent);
  return { repo, baseline, active, stagingParent, root: pathToFileURL(`${active}/`) };
}

function requireReady(result: Awaited<ReturnType<typeof prepareUpdate>>) {
  if (result.status !== "ready") throw new Error(`预检未得到可用候选，实际为 ${result.status}。`);
  return result;
}

test.skipIf(noGit)("已构建候选探测后可切换，失败可重试且旧仓不残留临时引用", () => fixture(async (temporary) => {
  const repo = await makeRepository(temporary, "deployment", {
    ".gitignore": "/data/\n/logs/\n/panel/dist/\n",
    "package.json": JSON.stringify({ name: "deployment-fixture", scripts: { typecheck: "bun -e 'void 0'" } }),
    "scripts/bootstrap.ts": `await Bun.write("panel/dist/fixture.txt", "built " + await Bun.file("revision.txt").text());`,
    "revision.txt": "old",
    "app.ts": `
      const git = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
      const revision = git.stdout.toString().trim();
      await Bun.write("logs/probe.txt", revision);
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
          if (request.headers.get("Authorization") !== "Bearer " + Bun.env.LOTUS_HTTP_TOKEN) return new Response(null, {status: 401});
          return Response.json({status: "ok", revision});
        },
      });
      console.log("HTTP 正在监听 " + server.url.origin + "/status");
      process.once("SIGTERM", () => { void server.stop(true); });
    `,
  });
  repo.publish("Fixture deployed baseline");
  const active = join(temporary, "active");
  repo.checkout(active);
  const root = pathToFileURL(`${active}/`);
  await writeFiles(active, { "data/fixture.txt": "live state", "logs/fixture.txt": "live logs" });
  await writeFiles(active, {
    "plugins/rejected/data/fixture.txt": "rejected plugin state",
    "plugins/loose.js": "// local script",
  });
  await symlink("absent", join(active, "plugins/occupied"));
  await writeFile(join(repo.writer, "revision.txt"), "next");
  repo.publish("Fixture deployable candidate");
  const ready = requireReady(await prepareUpdate(root, new Map()));
  const stage = await stageUpdate(root, new Map(), ready, temporary);
  try {
    expect(await readdir(join(stage.directory, "plugins"))).toEqual([]);
    await writeFile(join(active, "plugins/late.js"), "// added after staging");
    await expect(stage.activate(async () => {
      throw new Error("changed inventory must not become active");
    })).rejects.toThrow("活动插件目录在检查期间已变更");
    expect(await readFile(join(active, "plugins/late.js"), "utf8")).toBe("// added after staging");
    await unlink(join(active, "plugins/late.js"));
    await expect(stage.activate(async (current) => {
      await verifyUpdateHealth(current, ready.candidate);
      throw new Error("fixture health rejected");
    })).rejects.toThrow("fixture health rejected");
    expect(await readFile(join(active, "revision.txt"), "utf8")).toBe("old");
    expect(await readFile(join(active, "plugins/rejected/data/fixture.txt"), "utf8")).toBe("rejected plugin state");
    const result = await stage.activate((current) => verifyUpdateHealth(current, ready.candidate));
    expect(await readFile(join(active, "revision.txt"), "utf8")).toBe("next");
    expect(await readFile(join(active, "data/fixture.txt"), "utf8")).toBe("live state");
    expect(await readFile(join(active, "panel/dist/fixture.txt"), "utf8")).toBe("built next");
    expect(await readFile(join(active, "plugins/loose.js"), "utf8")).toBe("// local script");
    expect(await readFile(join(active, "plugins/rejected/data/fixture.txt"), "utf8")).toBe("rejected plugin state");
    expect((await readdir(join(active, "plugins"))).sort()).toEqual(["loose.js", "occupied", "rejected"]);
    expect(git(active, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(result.previous, "for-each-ref", "--format=%(refname)", "refs/lotus-yunzai/update")).toBe("");
  } finally {
    await stage.release();
    await ready.release();
  }
}), 15_000);

test.skipIf(noGit)("内置插件转换为子模块时迁移未跟踪的配置、数据与资源，冲突拒绝切换，失败恢复原文件", () => fixture(async (temporary) => {
  const host = await makeRepository(temporary, "gitlink-host", {
    "package.json": JSON.stringify({ name: "gitlink-host", scripts: { typecheck: "bun -e 'void 0'" } }),
    "scripts/bootstrap.ts": `
      const update = Bun.spawn(["git", "submodule", "update", "--init", "--recursive", "--checkout"]);
      if (await update.exited) process.exit(1);
    `,
    "plugins/genshin/.gitignore": "/config/local.yaml\n/data/\n/resources/old-theme\n",
    "plugins/genshin/config/default.yaml": "original defaults",
    "plugins/genshin/resources/committed.txt": "original resources",
    "app.ts": `
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (request.headers.get("Authorization") !== "Bearer " + Bun.env.LOTUS_HTTP_TOKEN) return new Response(null, { status: 401 });
        return Response.json({ status: "ok", revision });
      } });
      console.log("HTTP 正在监听 " + server.url.origin + "/status");
      process.once("SIGTERM", () => { void server.stop(true); });
    `,
  });
  const notice = await makeRepository(temporary, "gitlink-notice", { ".gitignore": "/data/\n", "index.ts": "// original notice" });
  const originalNotice = notice.publish("Fixture original notice");
  function addSubmodule(name: string) {
    git(host.writer, "-c", "protocol.file.allow=always", "submodule", "add", "-q",
      pathToFileURL(join(temporary, `gitlink-${name}.git`)).href, `plugins/${name}`);
  }
  addSubmodule("notice");
  const baseline = host.publish("Fixture host with inline genshin");
  const active = join(temporary, "active");
  host.checkout(active);
  git(active, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
  const state = {
    "plugins/genshin/config/local.yaml": "private fixture config",
    "plugins/genshin/data/archive.json": "{}\n",
    "plugins/genshin/.env.local": "PRIVATE_FIXTURE=yes\n",
    "plugins/genshin/resources/custom.txt": "private resource",
    "plugins/notice/data/local.json": "notice state",
  };
  await writeFiles(active, { ...state, "plugins/genshin/config/collision.yaml": "data in old worktree" });
  await symlink("/synthetic-resource-mount", join(active, "plugins/genshin/resources/old-theme"), "dir");
  await writeFile(join(notice.writer, "index.ts"), "// new notice");
  const newNotice = notice.publish("Fixture updated notice");
  git(join(host.writer, "plugins/notice"), "fetch", "-q", "origin");
  git(join(host.writer, "plugins/notice"), "checkout", "-q", newNotice);
  const genshin = await makeRepository(temporary, "gitlink-genshin", {
    "config/default.yaml": "new defaults",
    "config/collision.yaml": "new shipped config",
    "resources/committed.txt": "new resources",
    "index.ts": "// new genshin",
  });
  const newGenshin = genshin.publish("Fixture genshin submodule");
  git(host.writer, "rm", "-qr", "plugins/genshin");
  addSubmodule("genshin");
  const candidate = host.publish("Fixture host with pinned modules");
  const root = pathToFileURL(`${active}/`);
  const directories = new Map();
  // Force exercises archive verification for state held by an existing child Git index.
  const ready = requireReady(await prepareUpdate(root, directories, undefined, undefined, true));
  const stage = await stageUpdate(root, directories, ready, temporary);
  async function checkState(directory: string) {
    for (const [path, contents] of Object.entries(state)) {
      expect(await readFile(join(directory, path), "utf8")).toBe(contents);
    }
    expect(await readlink(join(directory, "plugins/genshin/resources/old-theme"))).toBe("/synthetic-resource-mount");
  }
  try {
    expect(await Bun.file(join(stage.directory, "plugins/genshin/config/local.yaml")).exists()).toBe(false);
    await expect(stage.activate(async () => {
      throw new Error("conflicting candidate must stay staged");
    })).rejects.toThrow("候选目录已包含运行状态");
    expect(git(active, "rev-parse", "HEAD")).toBe(baseline);
    expect(await readFile(join(active, "plugins/genshin/config/collision.yaml"), "utf8")).toBe("data in old worktree");
    await unlink(join(active, "plugins/genshin/config/collision.yaml"));
    await expect(stage.activate(async (directory) => {
      await checkState(directory);
      expect(git(join(directory, "plugins/genshin"), "rev-parse", "HEAD")).toBe(newGenshin);
      throw new Error("fixture live failure");
    })).rejects.toThrow("fixture live failure");
    expect(git(active, "rev-parse", "HEAD")).toBe(baseline);
    expect(git(join(active, "plugins/notice"), "rev-parse", "HEAD")).toBe(originalNotice);
    await checkState(active);
    const result = await stage.activate(async (directory) => {
      await checkState(directory);
      expect(git(directory, "rev-parse", "HEAD")).toBe(candidate);
      expect(git(join(directory, "plugins/genshin"), "rev-parse", "HEAD")).toBe(newGenshin);
      expect(git(join(directory, "plugins/notice"), "rev-parse", "HEAD")).toBe(newNotice);
      expect(await readFile(join(directory, "plugins/genshin/config/default.yaml"), "utf8")).toBe("new defaults");
    });
    expect(await readFile(join(result.previous, "plugins/genshin/config/default.yaml"), "utf8")).toBe("original defaults");
  } finally {
    await stage.release();
    await ready.release();
  }
}), 15_000);

async function assertRuntimeIsolation(active: string, staged?: string) {
  for (const file of runtimePaths) {
    expect(await readFile(join(active, file), "utf8")).toBe(`active ${file}`);
    if (staged) expect(await readFile(join(staged, file), "utf8")).toBe(`staged ${file}`);
  }
}

test.skipIf(noGit)("宿主候选在独立目录完成冻结安装和检查，失败时清理暂存区", () => fixture(async (temporary) => {
  const { repo, baseline, active, stagingParent, root } = await fixtureHost(temporary);
  const directories = new Map();
  await writeFile(join(repo.writer, "app.ts"), 'export const revision = "candidate host";\n');
  repo.publish("Fixture candidate host");
  const ready = requireReady(await prepareUpdate(root, directories));
  try {
    const stage = await stageUpdate(root, directories, ready, stagingParent);
    try {
      const location = relative(await realpath(stagingParent), await realpath(stage.directory));
      expect(location).not.toBe("");
      expect(location.startsWith("..")).toBe(false);
      expect(isAbsolute(location)).toBe(false);
      expect(await readFile(join(stage.directory, "typecheck-marker.txt"), "utf8")).toBe("candidate host");
      expect(await realpath(join(stage.directory, "node_modules/@fixture/local-dependency")))
        .toBe(await realpath(join(stage.directory, "packages/local-dependency")));
      await assertRuntimeIsolation(active, stage.directory);
    } finally {
      await stage.release();
    }
    expect(await readdir(stagingParent)).toEqual([]);
  } finally {
    await ready.release();
  }

  await writeFile(join(repo.writer, "scripts/typecheck.ts"), `${typecheck}\nprocess.exit(9);\n`);
  repo.publish("Fixture fails the type check");
  const failing = requireReady(await prepareUpdate(root, directories));
  try {
    await expect(stageUpdate(root, directories, failing, stagingParent)).rejects.toThrow("运行候选初始化和类型检查");
    expect(await readdir(stagingParent)).toEqual([]);
    await assertRuntimeIsolation(active);
    expect(git(active, "rev-parse", "HEAD")).toBe(baseline);
    expect(await Bun.file(join(active, "typecheck-marker.txt")).exists()).toBe(false);
  } finally {
    await failing.release();
  }
}), 20_000);

const pluginFiles = (name: string, revision: string) => ({
  "package.json": JSON.stringify({ name, type: "module", lotusYunzai: { entry: "./index.js" } }),
  "index.js": "export default { commands: {} };\n", "revision.txt": revision,
});

test.skipIf(noGit)("暂存外部插件候选时固定宿主和其他已加载插件的当前提交", () => fixture(async (temporary) => {
  const { repo, active, baseline, stagingParent, root } = await fixtureHost(temporary);
  const target = await makeRepository(temporary, "target", pluginFiles("@fixture/target", "active target"));
  const sibling = await makeRepository(temporary, "sibling", pluginFiles("@fixture/sibling", "active sibling"));
  const targetHead = target.publish("Fixture active target");
  const siblingHead = sibling.publish("Fixture active sibling");
  const targetPath = join(active, "plugins/target");
  const siblingPath = join(active, "plugins/sibling");
  const localPath = join(active, "plugins/local");
  await mkdir(join(active, "plugins"));
  target.checkout(targetPath);
  sibling.checkout(siblingPath);
  await writeFiles(localPath, {
    ...pluginFiles("@fixture/local", "local plugin"),
    ".env": "LOCAL_FIXTURE=private-local-value\n", ".env.production": "LOCAL_FIXTURE=private-profile-value\n",
    "node_modules/fixture.txt": "active local dependency",
    "lib/entry.js": "export default { commands: {} };\n",
    "assets/readme.txt": "local asset directory",
  });
  await unlink(join(localPath, "index.js"));
  await symlink("./lib/entry.js", join(localPath, "index.js"));
  await symlink("../lib/entry.js", join(localPath, "assets/entry.js"));
  const directories = new Map([
    ["target", { path: targetPath, packageName: "@fixture/target" }],
    ["sibling", { path: siblingPath, packageName: "@fixture/sibling" }],
    ["local", { path: localPath, packageName: "@fixture/local" }],
  ]);
  await Promise.all([
    writeFile(join(target.writer, "revision.txt"), "candidate target"),
    writeFile(join(sibling.writer, "revision.txt"), "upstream sibling"),
    writeFile(join(repo.writer, "app.ts"), 'export const revision = "upstream host";\n'),
  ]);
  target.publish("Fixture target update");
  sibling.publish("Fixture sibling update");
  repo.publish("Fixture host update");

  const ready = requireReady(await prepareUpdate(root, directories, "target"));
  try {
    const stage = await stageUpdate(root, directories, ready, stagingParent);
    try {
      expect(await readFile(join(stage.directory, "typecheck-marker.txt"), "utf8")).toBe("active host");
      expect(await readFile(join(stage.directory, "plugins/target/revision.txt"), "utf8")).toBe("candidate target");
      expect(await readFile(join(stage.directory, "plugins/sibling/revision.txt"), "utf8")).toBe("active sibling");
      const stagedLocal = join(stage.directory, "plugins/local");
      expect(await readFile(join(stagedLocal, "revision.txt"), "utf8")).toBe("local plugin");
      expect(await readlink(join(stagedLocal, "index.js"))).toBe("./lib/entry.js");
      expect(await readlink(join(stagedLocal, "assets/entry.js"))).toBe("../lib/entry.js");
      expect(await realpath(join(stagedLocal, "index.js"))).toBe(join(stagedLocal, "lib/entry.js"));
      for (const file of [".env", ".env.production", "node_modules/fixture.txt"]) {
        expect(await Bun.file(join(stagedLocal, file)).exists()).toBe(false);
      }
      await writeFile(join(stagedLocal, "revision.txt"), "staged local change");
      expect(await readFile(join(localPath, "revision.txt"), "utf8")).toBe("local plugin");
      await assertRuntimeIsolation(active, stage.directory);
    } finally {
      await stage.release();
    }
    expect(await readdir(stagingParent)).toEqual([]);
    expect(git(active, "rev-parse", "HEAD")).toBe(baseline);
    expect(git(targetPath, "rev-parse", "HEAD")).toBe(targetHead);
    expect(git(siblingPath, "rev-parse", "HEAD")).toBe(siblingHead);
  } finally {
    await ready.release();
  }
}), 20_000);

test.skipIf(noGit)("本地插件暂存拒绝包外、非普通文件和指向未复制路径的链接", () => fixture(async (temporary) => {
  const { repo, active, baseline, stagingParent, root } = await fixtureHost(temporary);
  const local = join(active, "plugins/local");
  const outside = join(temporary, "external-source.js");
  await writeFiles(local, {
    ...pluginFiles("@fixture/local", "local plugin"),
    "lib/target.js": "export {};\n",
    ".env.production": "LOCAL_FIXTURE=private-profile-value\n",
    "node_modules/fixture.js": "export {};\n",
  });
  await writeFile(outside, "not part of the plugin");
  await writeFile(join(repo.writer, "app.ts"), 'export const revision = "upstream host";\n');
  repo.publish("Fixture host update");
  await symlink("lib/target.js", join(local, "alias.js"));
  const directories = new Map([["local", { path: local, packageName: "@fixture/local" }]]);
  for (const target of [outside, relative(local, outside), join(local, "lib/target.js"), "lib", "missing.js",
    ".env.production", "node_modules/fixture.js", "alias.js", "alias.js/../lib/target.js"]) {
    const link = join(local, "unsupported.js");
    await symlink(target, link);
    const ready = requireReady(await prepareUpdate(root, directories));
    try {
      await expect(stageUpdate(root, directories, ready, stagingParent)).rejects.toThrow("准备外部插件");
      expect(await readdir(stagingParent)).toEqual([]);
      expect(await readlink(link)).toBe(target);
    } finally {
      await ready.release();
      await unlink(link);
    }
  }
  expect(git(active, "rev-parse", "HEAD")).toBe(baseline);
  expect(await readFile(outside, "utf8")).toBe("not part of the plugin");
}), 20_000);

test.skipIf(noGit)("批量候选一次切换宿主和两个外部插件，保留状态、上游并清理全部引用", () => fixture(async (temporary) => {
  const host = await makeRepository(temporary, "batch-host", {
    ".gitignore": "/plugins/\n",
    "package.json": JSON.stringify({ name: "batch-host", scripts: { typecheck: "bun -e 'void 0'" } }),
    "scripts/bootstrap.ts": `await Bun.write("build-marker.txt", "built");`,
    "stage.txt": "old",
    "app.ts": `
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (request.headers.get("Authorization") !== "Bearer " + Bun.env.LOTUS_HTTP_TOKEN) return new Response(null, { status: 401 });
        return Response.json({ status: "ok", revision });
      } });
      console.log("HTTP 正在监听 " + server.url.origin + "/status");
      process.once("SIGTERM", () => { void server.stop(true); });
    `,
  });
  const oldHost = host.publish("Fixture batch host baseline");
  const active = join(temporary, "active");
  host.checkout(active);
  await mkdir(join(active, "plugins"));
  const root = pathToFileURL(`${active}/`);
  const directories = new Map();
  const external = new Map<string, { path: string; old: string; next: string }>();
  for (const name of ["first", "second"]) {
    const packageName = `@fixture/${name}`;
    const plugin = await makeRepository(temporary, name, pluginFiles(packageName, `old ${name}`));
    const old = plugin.publish(`Fixture ${name} baseline`);
    const path = join(active, "plugins", name);
    plugin.checkout(path);
    await writeFiles(path, { "data/state.txt": `live ${name}` });
    await writeFile(join(plugin.writer, "revision.txt"), `candidate ${name}`);
    external.set(name, { path, old, next: plugin.publish(`Fixture ${name} candidate`) });
    directories.set(name, { path, packageName });
  }
  await writeFile(join(host.writer, "stage.txt"), "candidate");
  const newHost = host.publish("Fixture batch host candidate");
  const readyHost = requireReady(await prepareUpdate(root, directories));
  const readyPlugins = new Map<string, ReadyUpdate>();
  for (const name of external.keys()) readyPlugins.set(name, requireReady(await prepareUpdate(root, directories, name)));
  const batch: ReadyBatchUpdate = {
    status: "ready", scope: "all", host: readyHost, plugins: readyPlugins,
    async release() { await Promise.all([readyHost, ...readyPlugins.values()].map((candidate) => candidate.release())); },
  };
  let releases = 0;
  const invalid = { ...batch, async release() { releases++; } };
  const snapshot = new Map(directories);
  snapshot.delete("first");
  await expect(stageUpdate(root, snapshot, invalid, temporary)).rejects.toThrow("校验当前工作区");
  snapshot.set("system", directories.get("first"));
  const first = readyPlugins.get("first")!;
  const builtIn = { ...invalid, plugins: new Map([["system", { ...first, name: "system" }]]) };
  await expect(stageUpdate(root, snapshot, builtIn, temporary)).rejects.toThrow("校验当前工作区");
  expect(releases).toBe(2);
  const anchor = await stageUpdate(root, directories, { ...batch, host: { ...batch.host, candidate: oldHost } }, temporary);
  try {
    expect(anchor.revision).toBe(oldHost);
    expect(git(join(anchor.directory, "plugins", "first"), "rev-parse", "HEAD")).toBe(first.candidate);
  } finally {
    await anchor.release();
  }
  const stage = await stageUpdate(root, directories, batch, temporary);
  try {
    expect(stage.revision).toBe(newHost);
    expect(git(active, "rev-parse", "HEAD")).toBe(oldHost);
    expect(await readFile(join(stage.directory, "build-marker.txt"), "utf8")).toBe("built");
    for (const [name, { path, old, next }] of external) {
      expect(git(path, "rev-parse", "HEAD")).toBe(old);
      expect(git(join(stage.directory, "plugins", name), "rev-parse", "HEAD")).toBe(next);
    }
    const result = await stage.activate(async (current) => {
      expect(git(current, "rev-parse", "HEAD")).toBe(newHost);
      for (const [name, { path, next }] of external) {
        expect(git(path, "rev-parse", "HEAD")).toBe(next);
        expect(git(path, "config", "--get", "branch.main.remote")).toBe("origin");
        expect(await readFile(join(path, "data/state.txt"), "utf8")).toBe(`live ${name}`);
      }
    });
    for (const path of [result.previous, ...[...external.keys()].map((name) => join(result.previous, "plugins", name))]) {
      expect(git(path, "for-each-ref", "--format=%(refname)", "refs/lotus-yunzai/update")).toBe("");
    }
  } finally {
    await stage.release();
  }
}), 15_000);

async function forceFixture(temporary: string) {
  const host = await makeRepository(temporary, "force-host", {
    ".gitignore": "/config/\n/logs/\n/plugins/\n",
    "package.json": JSON.stringify({ name: "force-host", scripts: { typecheck: "bun -e 'void 0'" } }),
    "scripts/bootstrap.ts": "void 0;\n",
    "source.txt": "committed",
    "app.ts": `
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (request.headers.get("Authorization") !== "Bearer " + Bun.env.LOTUS_HTTP_TOKEN) return new Response(null, { status: 401 });
        return Response.json({ status: "ok", revision });
      } });
      console.log("HTTP 正在监听 " + server.url.origin + "/status");
      process.once("SIGTERM", () => { void server.stop(true); });
    `,
  });
  const baseline = host.publish("Force fixture baseline");
  const active = join(temporary, "active");
  host.checkout(active);
  await writeFiles(active, { "config/state.txt": "live settings" });
  return { host, active, baseline, root: pathToFileURL(`${active}/`) };
}

test.skipIf(noGit)("强制切换同提交的脏工作区，保留归档的 index 和修改并在切换前复核分支与上游", () => fixture(async (temporary) => {
  const { active, baseline, root } = await forceFixture(temporary);
  const directories = new Map();
  await writeFile(join(active, "source.txt"), "staged edit");
  git(active, "add", "source.txt");
  await writeFile(join(active, "source.txt"), "unstaged edit");
  const status = git(active, "status", "--porcelain=v1");
  const index = await readFile(join(active, ".git", "index"));
  const ready = requireReady(await prepareUpdate(root, directories, undefined, undefined, true));
  expect(ready.current).toBe(baseline);
  expect(ready.candidate).toBe(baseline);
  expect(await prepareUpdate(root, directories)).toMatchObject({ status: "dirty" });
  const batch: ReadyBatchUpdate = {
    status: "ready", scope: "all", force: true,
    host: { directory: active, current: baseline, candidate: baseline },
    plugins: new Map(), async release() {},
  };
  await expect(stageUpdate(root, directories, batch, temporary)).rejects.toThrow("校验当前工作区");
  const stage = await stageUpdate(root, directories, ready, temporary);
  try {
    expect(await readFile(join(stage.directory, "source.txt"), "utf8")).toBe("committed");
    expect(await readFile(join(active, ".git", "index"))).toEqual(index);
    expect(git(active, "status", "--porcelain=v1")).toBe(status);
    git(active, "switch", "--quiet", "-c", "same-sha");
    git(active, "branch", "--quiet", "--set-upstream-to=origin/main");
    expect(git(active, "rev-parse", "HEAD")).toBe(baseline);
    await expect(stage.activate(async () => {})).rejects.toThrow("分支或上游已变更");
    git(active, "switch", "--quiet", "main");
    git(active, "config", "branch.main.merge", "refs/heads/other");
    await expect(stage.activate(async () => {})).rejects.toThrow("分支或上游已变更");
    git(active, "config", "branch.main.merge", "refs/heads/main");
    const archivedIndex = await readFile(join(active, ".git", "index"));
    const switched = await stage.activate(async () => {});
    expect(git(active, "status", "--porcelain=v1")).toBe("");
    expect(await readFile(join(active, "config/state.txt"), "utf8")).toBe("live settings");
    expect(await readFile(join(switched.previous, ".git", "index"))).toEqual(archivedIndex);
    expect(git(switched.previous, "show", ":source.txt")).toBe("staged edit");
    expect(await readFile(join(switched.previous, "source.txt"), "utf8")).toBe("unstaged edit");
    expect(git(switched.previous, "status", "--porcelain=v1")).toBe(status);
  } finally {
    await stage.release();
    await ready.release();
  }
}), 15_000);

test.skipIf(noGit)("强制切换拒绝迁移 index 已跟踪的状态，以及依赖外部对象的工作区", () => fixture(async (temporary) => {
  const { active, baseline, root } = await forceFixture(temporary);
  const directories = new Map();
  git(active, "add", "-f", "config/state.txt");
  const ready = requireReady(await prepareUpdate(root, directories, undefined, undefined, true));
  const stage = await stageUpdate(root, directories, ready, temporary);
  try {
    await expect(stage.activate(async () => {})).rejects.toThrow("Git 路径重叠");
    expect(git(active, "rev-parse", "HEAD")).toBe(baseline);
    expect(git(active, "show", ":config/state.txt")).toBe("live settings");
    expect(await readFile(join(active, "config/state.txt"), "utf8")).toBe("live settings");
  } finally {
    await stage.release();
    await ready.release();
  }
  git(active, "commit", "--quiet", "-m", "Fixture accidentally tracked state");
  const localHead = git(active, "rev-parse", "HEAD");
  git(active, "rm", "--cached", "-f", "config/state.txt");
  expect(git(active, "ls-files", "--", "config/state.txt")).toBe("");
  const committed = requireReady(await prepareUpdate(root, directories, undefined, undefined, true));
  const stagedCommit = await stageUpdate(root, directories, committed, temporary);
  try {
    await expect(stagedCommit.activate(async () => {})).rejects.toThrow("Git 路径重叠");
    expect(git(active, "show", "HEAD:config/state.txt")).toBe("live settings");
  } finally {
    await stagedCommit.release();
    await committed.release();
  }
  const next = requireReady(await prepareUpdate(root, directories, undefined, undefined, true));
  const alternates = join(active, ".git/objects/info/alternates");
  await writeFile(alternates, join(temporary, "force-host.git/objects") + "\n");
  await expect(stageUpdate(root, directories, next, temporary)).rejects.toThrow("校验当前工作区");
  await unlink(alternates);
  const linked = requireReady(await prepareUpdate(root, directories, undefined, undefined, true));
  await symlink(join(active, ".git/refs/heads/main"), join(active, ".git/refs/heads/source-pointer"));
  await expect(stageUpdate(root, directories, linked, temporary)).rejects.toThrow("校验当前工作区");
  expect(git(active, "rev-parse", "HEAD")).toBe(localHead);
  expect(git(active, "for-each-ref", "--format=%(refname)", "refs/lotus-yunzai/update")).toBe("");
}), 15_000);

test.skipIf(noGit)("取消运行中的构建会清理暂存目录与候选引用", () => fixture(async (temporary) => {
  const { repo, baseline, active, stagingParent, root } = await fixtureHost(temporary);
  const entered = join(temporary, "build-entered");
  const continued = join(temporary, "build-continued");
  await writeFile(join(repo.writer, "scripts/bootstrap.ts"), `
    await Bun.write(${JSON.stringify(entered)}, "initializing");
    await Bun.sleep(2_000);
    await Bun.write(${JSON.stringify(continued)}, "continued");
  `);
  repo.publish("Fixture slow candidate");
  const directories = new Map();
  const ready = requireReady(await prepareUpdate(root, directories));
  const controller = new AbortController();
  try {
    const staged = stageUpdate(root, directories, ready, stagingParent, controller.signal);
    const result = staged.then(() => null, (error: unknown) => error);
    while (!await Bun.file(entered).exists()) {
      const finished = await Promise.race([result.then(() => true), Bun.sleep(20).then(() => false)]);
      if (finished) throw new Error("候选构建未进入初始化。");
    }
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(await Bun.file(continued).exists()).toBe(false);
    expect(await readdir(stagingParent)).toEqual([]);
    expect(git(active, "rev-parse", "HEAD")).toBe(baseline);
    expect(git(active, "for-each-ref", "--format=%(refname)", "refs/lotus-yunzai/update")).toBe("");
    await assertRuntimeIsolation(active);
  } finally {
    controller.abort();
    await ready.release();
  }
}), 10_000);
