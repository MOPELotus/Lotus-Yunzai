import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readRuntimeVersion } from "../lib/runtime-version.ts";

const executable = Bun.which("git");
const noGit = !executable;
const rootUrl = (directory: string) => pathToFileURL(`${directory}/`);

function git(directory: string, ...args: string[]): string {
  const command = Bun.spawnSync([executable!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always", ...args], {
    cwd: directory, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (command.exitCode !== 0) throw new Error(command.stderr.toString());
  return command.stdout.toString().trimEnd();
}

async function fixture(run: (temporary: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-runtime-version-"));
  try {
    await run(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function repository(directory: string, version?: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "private-fixture", version }));
  await writeFile(join(directory, "tracked.txt"), "tracked\n");
  git(directory, "init", "-q");
  git(directory, "add", "package.json", "tracked.txt");
  git(directory, "commit", "-qm", "initial");
  return git(directory, "rev-parse", "HEAD");
}

test("仅展示明确的合法 SemVer，缺失版本、无效版本或 JSON 不推断", () => fixture(async (directory) => {
  const file = join(directory, "package.json");
  for (const version of [undefined, 1, "v1.2.3", "1.2.3\n", "1.2.3-01", "1.02.3", "1.2.3+", " 1.2.3"]) {
    await writeFile(file, JSON.stringify({ version }));
    expect(await readRuntimeVersion(rootUrl(directory))).toEqual({ modules: [] });
  }
  await writeFile(file, '{"version":');
  expect(await readRuntimeVersion(rootUrl(directory))).toEqual({ modules: [] });
  await writeFile(file, JSON.stringify({ version: "0.3.2-rc.1+build.0001" }));
  expect(await readRuntimeVersion(rootUrl(directory))).toEqual({ version: "0.3.2-rc.1+build.0001", modules: [] });
}));

test.skipIf(noGit)("真实 checkout 读取完整 HEAD 和 tracked 脏状态，忽略普通未跟踪文件", () => fixture(async (temporary) => {
  const directory = join(temporary, "checkout");
  const revision = await repository(directory, "1.0.0");
  await writeFile(join(directory, "untracked.txt"), "untracked");
  expect(await readRuntimeVersion(rootUrl(directory))).toEqual({ version: "1.0.0", revision, modified: false, modules: [] });
  await writeFile(join(directory, "tracked.txt"), "local edit\n");
  expect(await readRuntimeVersion(rootUrl(directory))).toEqual({ version: "1.0.0", revision, modified: true, modules: [] });
}));

test.skipIf(noGit)("忽略污染的 Git 环境与父仓，允许已登记 worktree，拒绝复制的 .git 指针", () => fixture(async (temporary) => {
  const directory = join(temporary, "checkout");
  const revision = await repository(directory);
  const unrelated = join(temporary, "unrelated");
  await repository(unrelated, "2.0.0");
  const nested = join(directory, "nested");
  await mkdir(nested);
  const worktree = join(temporary, "real worktree");
  git(directory, "worktree", "add", "--detach", "--quiet", worktree);
  const fake = join(temporary, "copied worktree");
  await mkdir(fake);
  await copyFile(join(worktree, ".git"), join(fake, ".git"));
  await copyFile(join(worktree, "package.json"), join(fake, "package.json"));

  const override = { GIT_DIR: join(unrelated, ".git"), GIT_WORK_TREE: unrelated, GIT_INDEX_FILE: join(unrelated, ".git/index"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: unrelated };
  const previous = Object.fromEntries(Object.keys(override).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, override);
    expect(await readRuntimeVersion(rootUrl(directory))).toEqual({ revision, modified: false, modules: [] });
    expect(await readRuntimeVersion(rootUrl(worktree))).toEqual({ revision, modified: false, modules: [] });
    expect(await readRuntimeVersion(rootUrl(nested))).toEqual({ modules: [] });
    expect(await readRuntimeVersion(rootUrl(fake))).toEqual({ modules: [] });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}));

test.skipIf(noGit)("已安装的内置 gitlink 显示实际模块 HEAD，忽略锁指针、未安装和第三方名字", () => fixture(async (temporary) => {
  const directory = join(temporary, "checkout");
  await repository(directory);
  const source = join(temporary, "source");
  const old = await repository(source);
  for (const slug of ["group", "atlas", "private-module"]) git(directory, "submodule", "add", "--quiet", source, `plugins/${slug}`);
  const ordinary = join(directory, "plugins", "system");
  await mkdir(ordinary);
  await writeFile(join(ordinary, "package.json"), JSON.stringify({ name: "ordinary-system", version: "2.0.0" }));
  git(directory, "add", "plugins/system/package.json");
  git(directory, "commit", "-qam", "tracked module definitions");
  git(directory, "submodule", "deinit", "--quiet", "plugins/atlas");
  const working = join(directory, "plugins", "group");

  expect(await readRuntimeVersion(rootUrl(directory))).toEqual({ revision: git(directory, "rev-parse", "HEAD"),
    modified: false, modules: [{ name: "group", revision: old }] });
  await writeFile(join(working, "tracked.txt"), "module edit\n");
  expect((await readRuntimeVersion(rootUrl(directory))).modified).toBe(true);
  git(working, "commit", "-qam", "actual revision changed");
  const actual = git(working, "rev-parse", "HEAD");
  expect(actual).not.toBe(old);
  const result = await readRuntimeVersion(rootUrl(directory));
  expect(result.modules).toEqual([{ name: "group", revision: actual }]);
  expect(result.modified).toBe(true);
}));

test.skipIf(noGit)("读取脏状态不执行仓库配置的 fsmonitor 或外部 clean 过滤器", () => fixture(async (temporary) => {
  const directory = join(temporary, "checkout");
  await repository(directory);
  const hook = join(temporary, "hook");
  const marker = join(directory, "hook-executed");
  await writeFile(hook, '#!/bin/sh\nprintf executed > hook-executed\ncat\n', { mode: 0o700 });
  await writeFile(join(directory, ".gitattributes"), "tracked.txt filter=fixture\n");
  git(directory, "add", ".gitattributes");
  git(directory, "commit", "-qm", "fixture attributes");
  git(directory, "config", "core.fsmonitor", hook);
  git(directory, "config", "filter.fixture.clean", hook);
  git(directory, "config", "filter.fixture.required", "true");
  await writeFile(join(directory, "tracked.txt"), "local edit\n");
  expect((await readRuntimeVersion(rootUrl(directory))).modified).toBe(true);
  expect(await Bun.file(marker).exists()).toBe(false);
}));
