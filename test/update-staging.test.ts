import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareUpdate } from "../lib/update-preflight.ts";
import { stageUpdate } from "../lib/update-staging.ts";

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
  });
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
