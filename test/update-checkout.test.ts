import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkoutUpdateRevision } from "../lib/update-checkout.ts";

const executable = Bun.which("git");

test.skipIf(!executable)("shallow source boundaries survive repeated independent update checkouts", () => fixture(async (root, source) => {
  await commit(source, "first\n");
  const revision = await commit(source, "second\n");
  const shallow = join(root, "shallow");
  git(source, "clone", "--quiet", "--depth=1", pathToFileURL(source).href, shallow);
  expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
  let previous = shallow;
  for (let index = 0; index < 2; index++) {
    const target = join(root, `candidate-${index}`);
    await checkoutUpdateRevision(previous, revision, target);
    expect(git(target, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(target, "fsck", "--connectivity-only", "--no-dangling")).toBe("");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("second\n");
    previous = target;
  }
}));

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync([executable!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", `core.hooksPath=${devNull}`, ...args], {
    cwd: directory, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}

async function fixture(run: (root: string, source: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-update-checkout-"));
  try {
    const source = join(root, "original checkout");
    await mkdir(source);
    git(source, "init", "--quiet", "--initial-branch=main");
    await run(root, source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commit(directory: string, content: string): Promise<string> {
  await writeFile(join(directory, "tracked.txt"), content);
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-qm", "isolated checkout fixture");
  return git(directory, "rev-parse", "HEAD");
}

test.skipIf(!executable)("准确物化本地候选提交，不复用对象、不移动源 refs 或索引，也不联系保留的 origin", () => fixture(async (root, source) => {
  const first = await commit(source, "正在运行的版本\n");
  const revision = await commit(source, "当前已拉取的候选\n");
  git(source, "update-ref", "refs/lotus-yunzai/update/fixture", revision);
  git(source, "reset", "--hard", first);
  git(source, "remote", "add", "origin", "https://fixture-user:fixture-secret@invalid.example.invalid/fixture.git");
  const tracked = join(source, "tracked.txt");
  const index = await readFile(join(source, ".git/index"));
  const config = await readFile(join(source, ".git/config"));
  const refs = git(source, "for-each-ref", "--format=%(refname) %(objectname)");

  const staged = join(root, "candidate checkout");
  await mkdir(staged);
  await checkoutUpdateRevision(source, revision, staged);
  expect(git(staged, "rev-parse", "HEAD")).toBe(revision);
  expect(git(staged, "branch", "--show-current")).toBe("");
  expect(git(staged, "remote", "get-url", "origin")).toBe("https://invalid.example.invalid/fixture.git");
  expect(await readFile(join(staged, "tracked.txt"), "utf8")).toBe("当前已拉取的候选\n");
  expect(await Bun.file(join(staged, ".git/objects/info/alternates")).exists()).toBe(false);
  expect(git(staged, "for-each-ref", "--format=%(refname)")).toBe("");
  const objects = await readdir(join(staged, ".git/objects"), { recursive: true, withFileTypes: true });
  const files = objects.filter((entry) => entry.isFile());
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) expect((await stat(join(file.parentPath, file.name))).nlink).toBe(1);

  expect(git(source, "rev-parse", "HEAD")).toBe(first);
  expect(git(source, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
  expect(await readFile(join(source, ".git/index"))).toEqual(index);
  expect(await readFile(join(source, ".git/config"))).toEqual(config);
  expect(await readFile(tracked, "utf8")).toBe("正在运行的版本\n");

  git(source, "remote", "add", "upstream", "../fixture-main-origin.git");
  git(source, "config", "branch.main.remote", "upstream");
  git(source, "config", "branch.main.merge", "refs/heads/main");
  const stagedUpstream = join(root, "candidate from upstream");
  await checkoutUpdateRevision(source, revision, stagedUpstream);
  expect(git(stagedUpstream, "remote", "get-url", "origin")).toBe(join(root, "fixture-main-origin.git"));

  await rm(source, { recursive: true, force: true });
  expect(git(staged, "show", "HEAD:tracked.txt")).toBe("当前已拉取的候选");
}));

test.skipIf(!executable)("已登记的 worktree 来源可用，独立 checkout 保留源相对文件 origin 的含义，不使用源过滤器", () => fixture(async (root, source) => {
  const sample = "原始内容\n";
  await commit(source, sample);
  await writeFile(join(source, ".gitattributes"), "tracked.txt filter=fixture\n");
  git(source, "add", ".gitattributes");
  git(source, "commit", "-qm", "tracked attributes");
  const revision = git(source, "rev-parse", "HEAD");
  const worktree = join(root, "worktree");
  git(source, "worktree", "add", "--detach", "--quiet", worktree);
  const filter = join(root, "fixture-filter");
  await writeFile(filter, '#!/bin/sh\nprintf smudged > fixture-filter-ran\ncat\n', { mode: 0o700 });
  git(source, "config", "filter.fixture.smudge", filter);
  git(source, "config", "filter.fixture.required", "true");
  git(source, "remote", "add", "origin", "../fixture-upstream.git");

  const stageParent = join(root, "builds");
  await mkdir(stageParent);
  const staged = join(stageParent, "candidate");
  await checkoutUpdateRevision(worktree, revision, staged);
  expect(git(staged, "remote", "get-url", "origin")).toBe(join(root, "fixture-upstream.git"));
  expect(await readFile(join(staged, "tracked.txt"), "utf8")).toBe(sample);
  expect(await Bun.file(join(staged, "fixture-filter-ran")).exists()).toBe(false);
  expect(await Bun.file(join(worktree, "fixture-filter-ran")).exists()).toBe(false);
  expect(await Bun.file(join(source, "fixture-filter-ran")).exists()).toBe(false);

  git(source, "remote", "set-url", "origin", "ssh://git:fixture-secret@invalid.example.invalid/repo.git");
  const sshStage = join(stageParent, "ssh");
  await checkoutUpdateRevision(worktree, revision, sshStage);
  expect(git(sshStage, "remote", "get-url", "origin")).toBe("ssh://git@invalid.example.invalid/repo.git");
}));

test.skipIf(!executable)("拒绝不完整或缺失的提交、仓库内目标和非空或链接目标", () => fixture(async (root, source) => {
  const revision = await commit(source, "原始内容\n");
  const destination = join(root, "declined");
  await expect(checkoutUpdateRevision(source, revision.slice(0, 8), destination)).rejects.toThrow("完整提交号");
  await expect(checkoutUpdateRevision(source, "1".repeat(40), destination)).rejects.toThrow("不可用");
  await expect(checkoutUpdateRevision(source, revision, join(source, "not-independent"))).rejects.toThrow("独立");
  await expect(checkoutUpdateRevision(source, revision, source)).rejects.toThrow("独立");

  const nonempty = join(root, "nonempty");
  const alias = join(root, "alias");
  await mkdir(nonempty);
  await writeFile(join(nonempty, "existing"), "保留\n");
  await symlink(nonempty, alias);
  await expect(checkoutUpdateRevision(source, revision, nonempty)).rejects.toThrow("空目录");
  await expect(checkoutUpdateRevision(source, revision, alias)).rejects.toThrow("空目录");
  expect(await readFile(join(nonempty, "existing"), "utf8")).toBe("保留\n");
  expect(await readdir(source)).not.toContain("not-independent");

  git(source, "remote", "add", "origin", "https://invalid.example.invalid/repo.git?token=fixture-secret#ref");
  await expect(checkoutUpdateRevision(source, revision, destination)).rejects.toThrow("查询参数或片段");
  expect(await readdir(root)).not.toContain("declined");
}));
