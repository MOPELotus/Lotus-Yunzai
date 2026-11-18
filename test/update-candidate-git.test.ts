import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUpdateCandidate, type UpdateCandidateResult } from "../lib/update-candidate-git.ts";

const executable = Bun.which("git");

function git(directory: string, ...args: string[]): string {
  const task = Bun.spawnSync([executable!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always", ...args], {
    cwd: directory, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (task.exitCode !== 0) throw new Error(task.stderr.toString());
  return task.stdout.toString().trimEnd();
}

async function commit(directory: string, data: string) {
  await writeFile(join(directory, "tracked.txt"), data);
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-qm", "Fixture change");
  return git(directory, "rev-parse", "HEAD");
}

async function fixture(run: (value: { parent: string; bare: string; source: string; checkout: string; first: string }) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "lotus-update-candidate-"));
  try {
    const bare = join(parent, "origin.git");
    const source = join(parent, "source");
    const checkout = join(parent, "checkout");
    await mkdir(source);
    git(parent, "init", "--bare", "--initial-branch=main", "-q", bare);
    git(source, "init", "--initial-branch=main", "-q");
    const first = await commit(source, "old\n");
    git(source, "remote", "add", "origin", bare);
    git(source, "push", "--quiet", "--set-upstream", "origin", "main");
    git(parent, "clone", "--quiet", bare, checkout);
    await run({ parent, bare, source, checkout, first });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function refs(checkout: string) {
  return git(checkout, "for-each-ref", "--format=%(refname) %(objectname)");
}

async function checkCandidate(result: UpdateCandidateResult, checkout: string, status: "ready" | "current" | "ahead" | "diverged", current: string, candidate: string) {
  expect(result).toMatchObject({ status, current, candidate });
  if (!("release" in result)) throw new Error("缺少候选释放回调");
  try {
    expect(git(checkout, "for-each-ref", "--format=%(objectname)", "refs/lotus-yunzai/update")).toBe(candidate);
  } finally {
    await Promise.all([result.release(), result.release()]);
  }
  await result.release();
  expect(git(checkout, "for-each-ref", "--format=%(objectname)", "refs/lotus-yunzai/update")).toBe("");
}

test.skipIf(!executable)("本地远端更新候选可识别 current/ready/ahead/diverged，且只保留临时引用", () => fixture(async ({ source, checkout, first }) => {
  const fetchHead = join(checkout, ".git", "FETCH_HEAD");
  await writeFile(fetchHead, "留存旧 FETCH_HEAD\n");
  git(checkout, "update-ref", "refs/remotes/origin/local-only", first);
  git(checkout, "config", "remote.origin.prune", "true");
  git(checkout, "config", "remote.origin.tagOpt", "--tags");
  const originalRefs = refs(checkout);
  const index = await readFile(join(checkout, ".git", "index"));
  await checkCandidate(await fetchUpdateCandidate(checkout), checkout, "current", first, first);

  const upstream = await commit(source, "upstream\n");
  git(source, "tag", "unrelated-tag");
  git(source, "push", "--quiet", "--tags", "origin", "main");
  await checkCandidate(await fetchUpdateCandidate(checkout), checkout, "ready", first, upstream);
  expect(refs(checkout)).toBe(originalRefs);
  expect(await readFile(join(checkout, ".git", "index"))).toEqual(index);
  expect(await readFile(fetchHead, "utf8")).toBe("留存旧 FETCH_HEAD\n");
  expect(await readFile(join(checkout, "tracked.txt"), "utf8")).toBe("old\n");
  expect(git(checkout, "symbolic-ref", "HEAD")).toBe("refs/heads/main");

  const local = await commit(checkout, "local\n");
  await checkCandidate(await fetchUpdateCandidate(checkout), checkout, "diverged", local, upstream);
  git(source, "push", "--quiet", "origin", `${first}:refs/heads/older`);
  git(checkout, "config", "branch.main.merge", "refs/heads/older");
  await checkCandidate(await fetchUpdateCandidate(checkout), checkout, "ahead", local, first);
}));

test.skipIf(!executable)("拒绝脏工作树、暂存改动、detached HEAD、未配置和错误上游", () => fixture(async ({ parent, checkout }) => {
  await writeFile(join(checkout, "tracked.txt"), "unstaged\n");
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "dirty" });
  git(checkout, "add", "tracked.txt");
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "dirty" });
  git(checkout, "restore", "--staged", "--worktree", "tracked.txt");
  await writeFile(join(checkout, "untracked.txt"), "保留非跟踪文件\n");
  const candidate = await fetchUpdateCandidate(checkout);
  expect(candidate.status).toBe("current");
  if ("release" in candidate) await candidate.release();
  expect(await readFile(join(checkout, "untracked.txt"), "utf8")).toBe("保留非跟踪文件\n");

  git(checkout, "checkout", "--detach", "--quiet");
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "unavailable" });
  git(checkout, "switch", "--quiet", "main");
  git(checkout, "config", "--add", "branch.main.merge", "refs/heads/second-merge");
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "unavailable" });
  git(checkout, "config", "--unset-all", "branch.main.merge");
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "unavailable" });
  git(checkout, "config", "branch.main.merge", "refs/tags/wrong-kind");
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "unavailable" });
  git(checkout, "config", "branch.main.merge", "refs/heads/missing-upstream");
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "unavailable" });
  expect(git(checkout, "for-each-ref", "--format=%(refname)", "refs/lotus-yunzai/update")).toBe("");
  await mkdir(join(checkout, "nested"));
  await symlink(checkout, join(parent, "alias"));
  expect(await fetchUpdateCandidate(join(checkout, "nested"))).toEqual({ status: "unavailable" });
  expect(await fetchUpdateCandidate(join(parent, "alias"))).toEqual({ status: "unavailable" });
}));

test.skipIf(!executable)("不运行配置的 Git hook 或过滤器，拒绝 ext 及 URL 重写", () => fixture(async ({ parent, bare, checkout, first }) => {
  const marker = join(checkout, "hook-ran");
  const hook = '#!/bin/sh\nprintf executed > hook-ran\ncat\n';
  const filter = join(parent, "fake-filter");
  await writeFile(join(checkout, ".git", "hooks", "reference-transaction"), hook, { mode: 0o700 });
  await checkCandidate(await fetchUpdateCandidate(checkout), checkout, "current", first, first);
  expect(await Bun.file(marker).exists()).toBe(false);
  await writeFile(filter, hook, { mode: 0o700 });
  await writeFile(join(checkout, ".gitattributes"), "tracked.txt filter=fixture\n");
  git(checkout, "config", "filter.fixture.clean", filter);
  git(checkout, "config", "filter.fixture.required", "true");
  await writeFile(join(checkout, "tracked.txt"), "changed\n");
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "dirty" });
  expect(await Bun.file(marker).exists()).toBe(false);

  git(checkout, "config", "--remove-section", "filter.fixture");
  await rm(join(checkout, ".gitattributes"));
  git(checkout, "restore", "tracked.txt");
  git(checkout, "config", "remote.origin.url", `ext::${filter}`);
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "unavailable" });
  git(checkout, "config", "remote.origin.url", bare);
  git(checkout, "config", `url.ext::${filter}/.insteadOf`, bare);
  expect(await fetchUpdateCandidate(checkout)).toEqual({ status: "unavailable" });
  expect(await Bun.file(marker).exists()).toBe(false);
}));

test.skipIf(!executable)("配置的 bundle URI 不会从另一来源导入 Git 对象或引用", () => fixture(async ({ parent, checkout, first }) => {
  const separate = join(parent, "unrelated");
  const bundle = join(parent, "unrelated.bundle");
  await mkdir(separate);
  git(separate, "init", "--initial-branch=main", "-q");
  const unrelated = await commit(separate, "unrelated bundle object\n");
  git(separate, "bundle", "create", bundle, "--all");
  git(checkout, "config", "fetch.bundleURI", bundle);
  const original = refs(checkout);
  await checkCandidate(await fetchUpdateCandidate(checkout), checkout, "current", first, first);
  expect(refs(checkout)).toBe(original);
  expect(git(checkout, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").split("\n")).not.toContain(unrelated);
}));
