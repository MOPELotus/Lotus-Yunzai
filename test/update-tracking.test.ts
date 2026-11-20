import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUpdateCandidate } from "../lib/update-candidate-git.ts";
import { checkoutUpdateRevision } from "../lib/update-checkout.ts";
import { restoreUpdateTracking } from "../lib/update-tracking.ts";

const executable = Bun.which("git");

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync([executable!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", `core.hooksPath=${devNull}`, "-c", "protocol.file.allow=always", ...args], {
    cwd: directory, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-update-tracking-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commit(directory: string, content: string) {
  await writeFile(join(directory, "tracked.txt"), content);
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-qm", "update tracking fixture");
  return git(directory, "rev-parse", "HEAD");
}

test.skipIf(!executable)("恢复当地分支和非 origin 上游后，候选可继续拉取下一提交，原仓不变", () => fixture(async (root) => {
  const upstream = join(root, "upstream.git");
  const writer = join(root, "writer");
  const source = join(root, "source");
  const staged = join(root, "staged");
  git(root, "init", "--bare", "--quiet", "--initial-branch=release/next", upstream);
  await mkdir(writer);
  git(writer, "init", "--quiet", "--initial-branch=release/next");
  const base = await commit(writer, "first\n");
  git(writer, "remote", "add", "origin", upstream);
  git(writer, "push", "--quiet", "origin", "release/next");
  git(root, "clone", "--quiet", upstream, source);
  git(source, "branch", "-m", "local/managed");
  git(source, "remote", "rename", "origin", "managed");
  git(source, "remote", "add", "origin", "https://unused.example.invalid/traditional-origin");
  git(source, "update-ref", "refs/remotes/managed/private", base);
  git(source, "config", "core.hooksPath", "/fixture/nonexistent/custom-hooks");
  const config = await readFile(join(source, ".git/config"));
  const sourceIndex = await readFile(join(source, ".git/index"));
  const sourceRefs = git(source, "for-each-ref", "--format=%(refname) %(objectname)");

  const next = await commit(writer, "second\n");
  git(writer, "push", "--quiet", "origin", "release/next");
  const candidate = await fetchUpdateCandidate(source);
  expect(candidate).toMatchObject({ status: "ready", current: base, candidate: next });
  if (!("release" in candidate) || !candidate.binding) throw new Error("expected verified upstream binding");
  try {
    await checkoutUpdateRevision(source, next, staged);
  } finally {
    await candidate.release();
  }
  const stageIndex = await readFile(join(staged, ".git/index"));
  git(staged, "update-ref", "refs/remotes/managed/unrelated", base);
  await expect(restoreUpdateTracking(source, staged, base, next, "0".repeat(64))).rejects.toThrow("上游已变更");
  expect(git(staged, "branch", "--show-current")).toBe("");
  await restoreUpdateTracking(source, staged, base, next, candidate.binding);
  expect(git(staged, "symbolic-ref", "HEAD")).toBe("refs/heads/local/managed");
  expect(git(staged, "rev-parse", "HEAD")).toBe(next);
  expect(git(staged, "config", "branch.local/managed.remote")).toBe("managed");
  expect(git(staged, "config", "branch.local/managed.merge")).toBe("refs/heads/release/next");
  expect(git(staged, "remote", "get-url", "managed")).toBe(upstream);
  expect(git(staged, "rev-parse", "@{upstream}")).toBe(next);
  expect(git(staged, "status", "--short", "--branch")).toBe("## local/managed...managed/release/next");
  expect(git(staged, "for-each-ref", "--format=%(refname)", "refs/remotes")).toBe(
    "refs/remotes/managed/release/next\nrefs/remotes/managed/unrelated");
  expect(await readFile(join(staged, ".git/config"), "utf8")).not.toContain("custom-hooks");
  expect(await readFile(join(staged, ".git/index"))).toEqual(stageIndex);
  expect(await readFile(join(source, ".git/config"))).toEqual(config);
  expect(await readFile(join(source, ".git/index"))).toEqual(sourceIndex);
  expect(git(source, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(sourceRefs);
  expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("first\n");

  const newest = await commit(writer, "third\n");
  git(writer, "push", "--quiet", "origin", "release/next");
  const subsequent = await fetchUpdateCandidate(staged);
  expect(subsequent).toMatchObject({ status: "ready", current: next, candidate: newest });
  if ("release" in subsequent) await subsequent.release();
  git(staged, "pull", "--ff-only");
  expect(git(staged, "rev-parse", "HEAD", "@{upstream}")).toBe(`${newest}\n${newest}`);
}));

test.skipIf(!executable)("分支或预期 SHA 变化时拒绝，保留候选的内容与 detached 状态", () => fixture(async (root) => {
  const source = join(root, "source");
  const staged = join(root, "staged");
  await mkdir(source);
  git(source, "init", "--quiet", "--initial-branch=main");
  const first = await commit(source, "first\n");
  const next = await commit(source, "next\n");
  await checkoutUpdateRevision(source, next, staged);
  await expect(restoreUpdateTracking(source, staged, first, next)).rejects.toThrow("状态已变更");
  await expect(restoreUpdateTracking(source, staged, next, first)).rejects.toThrow("状态已变更");
  expect(git(staged, "branch", "--show-current")).toBe("");
  await restoreUpdateTracking(source, staged, next, next);
  expect(git(staged, "branch", "--show-current")).toBe("main");
  await expect(restoreUpdateTracking(source, staged, next, next)).rejects.toThrow("状态已变更");
  expect(await readFile(join(staged, "tracked.txt"), "utf8")).toBe("next\n");

  const pinned = join(root, "pinned");
  git(source, "checkout", "--detach", "--quiet", first);
  await checkoutUpdateRevision(source, first, pinned);
  await restoreUpdateTracking(source, pinned, first, first);
  expect(git(pinned, "branch", "--show-current")).toBe("");
}));

test.skipIf(!executable)("恢复绑定使用候选已净化地址，拒绝带凭据的候选 origin", () => fixture(async (root) => {
  const source = join(root, "source");
  const staged = join(root, "staged");
  await mkdir(source);
  git(source, "init", "--quiet", "--initial-branch=main");
  const revision = await commit(source, "ready\n");
  git(source, "remote", "add", "admin-upstream", "https://abc:fixture-only@example.invalid/repo");
  git(source, "config", "branch.main.remote", "admin-upstream");
  git(source, "config", "branch.main.merge", "refs/heads/main");
  await checkoutUpdateRevision(source, revision, staged);
  git(staged, "remote", "set-url", "origin", "https://abc:fixture-only@example.invalid/repo");
  await expect(restoreUpdateTracking(source, staged, revision, revision)).rejects.toThrow("包含凭据");
  expect(git(staged, "branch", "--show-current")).toBe("");
  git(staged, "remote", "set-url", "origin", "https://example.invalid/repo");
  await restoreUpdateTracking(source, staged, revision, revision);
  expect(git(staged, "remote", "get-url", "admin-upstream")).toBe("https://example.invalid/repo");
  expect(git(staged, "for-each-ref", "refs/remotes")).toBe("");
  expect(await readFile(join(staged, ".git/config"), "utf8")).not.toContain("fixture-only");
}));
