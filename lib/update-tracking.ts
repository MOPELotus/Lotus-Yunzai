import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createLocalGit, gitHead, isGitCheckout, isGitRevision, type LocalGit } from "./local-git.ts";
import { updateBindingFingerprint } from "./update-candidate-git.ts";

async function localConfig(git: LocalGit, directory: string, key: string): Promise<string | undefined> {
  const result = await git(directory, ["config", "--local", "--no-includes", "--null", "--get-all", key], true);
  if (result === "") return;
  const value = result && /^([^\u0000-\u001f\u007f]+)\0$/u.exec(result)?.[1];
  if (!value) throw new Error("Git 跟踪配置不是单一有效值。");
  return value;
}

async function validStageOrigin(git: LocalGit, directory: string): Promise<string> {
  const url = await localConfig(git, directory, "remote.origin.url");
  if (!url || /^[+-]|^[^/:]+::/u.test(url) || await git(directory, ["remote", "get-url", "--all", "origin"]) !== `${url}\n`) {
    throw new Error("候选缺少有效的上游地址。");
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (!["file", "git", "http", "https", "ssh"].includes(scheme) || url.includes("?") || url.includes("#")) {
      throw new Error("候选上游地址无效。");
    }
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      throw new Error("候选上游地址无效。");
    }
    if (address.password || (scheme !== "ssh" && address.username)) throw new Error("候选上游地址包含凭据。");
  }
  return url;
}

async function apply(git: LocalGit, directory: string, ...args: string[]): Promise<void> {
  if (await git(directory, args) === undefined) throw new Error("无法恢复候选 Git 跟踪关系。");
}

function nested(parent: string, child: string): boolean {
  const local = relative(parent, child);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

export async function restoreUpdateTracking(source: string, candidate: string, expectedSource: string,
  expectedCandidate: string, binding?: string): Promise<void> {
  const git = createLocalGit();
  if (!git || ![expectedSource, expectedCandidate].every((revision) => isGitRevision(revision) && revision.trim() === revision)) {
    throw new Error("恢复跟踪关系需要本地 Git 和完整提交号。");
  }

  const [old, staged] = await Promise.all([realpath(source), realpath(candidate)]);
  if (nested(old, staged) || nested(staged, old) || !(await lstat(join(staged, ".git"))).isDirectory() ||
      !await isGitCheckout(git, old) || !await isGitCheckout(git, staged)) {
    throw new Error("候选须为独立 Git 工作区。");
  }
  const [oldHead, stagedHead, oldRef, stageRef] = await Promise.all([
    gitHead(git, old), gitHead(git, staged),
    git(old, ["symbolic-ref", "--quiet", "HEAD"], true), git(staged, ["symbolic-ref", "--quiet", "HEAD"], true),
  ]);
  if (oldHead !== expectedSource || stagedHead !== expectedCandidate || oldRef === undefined || stageRef !== "") {
    throw new Error("源或候选 Git 提交或分支状态已变更。");
  }
  if (binding && await updateBindingFingerprint(git, old) !== binding) {
    throw new Error("更新来源的分支或上游已变更。");
  }
  if (!oldRef) return;

  const ref = oldRef.trimEnd();
  if (!ref.startsWith("refs/heads/") || await git(old, ["check-ref-format", ref]) === undefined) {
    throw new Error("源 Git 分支名称无效。");
  }
  const key = `branch.${ref.slice("refs/heads/".length)}`;
  const [remote, merge] = await Promise.all([
    localConfig(git, old, `${key}.remote`), localConfig(git, old, `${key}.merge`),
  ]);
  if (remote || merge) {
    if (!remote || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remote) || !merge?.startsWith("refs/heads/") ||
        await git(old, ["check-ref-format", merge]) === undefined) throw new Error("源 Git 上游配置无效。");
    const origin = await validStageOrigin(git, staged);
    if (remote !== "origin") await apply(git, staged, "remote", "add", "--", remote, origin);
    await apply(git, staged, "config", "--local", `${key}.remote`, remote);
    await apply(git, staged, "config", "--local", `${key}.merge`, merge);
    if (binding) {
      // Only the accepted host candidate receives the ref verified by its upstream fetch.
      const trackingRef = `refs/remotes/${remote}/${merge.slice("refs/heads/".length)}`;
      await apply(git, staged, "update-ref", "--no-deref", trackingRef, expectedCandidate, "0".repeat(expectedCandidate.length));
    }
  }

  // Bind HEAD without checking files out or refreshing the candidate's index.
  await apply(git, staged, "update-ref", "--no-deref", ref, expectedCandidate, "0".repeat(expectedCandidate.length));
  await apply(git, staged, "symbolic-ref", "HEAD", ref);
}
