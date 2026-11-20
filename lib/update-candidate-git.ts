import { realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { resolve } from "node:path";
import { runUpdateProcess } from "./update-build.ts";
import { createLocalGit, gitHead, isGitCheckout, isGitRevision, type LocalGit } from "./local-git.ts";

export type UpdateCandidateResult =
  | { readonly status: "unavailable" | "dirty" }
  | { readonly status: "ready" | "current" | "ahead" | "diverged";
      readonly current: string; readonly candidate: string; readonly binding?: string; readonly release: () => Promise<void> };

type Upstream = { readonly branch: string; readonly remote: string; readonly merge: string; readonly url: string };

export async function updateUpstreamBinding(
  git: LocalGit, directory: string,
): Promise<"bound" | "unbound" | "unavailable"> {
  const branch = (await git(directory, ["symbolic-ref", "--quiet", "HEAD"], true))?.trimEnd();
  if (branch === "") return "unbound";
  if (!branch?.startsWith("refs/heads/")) return "unavailable";
  const key = `branch.${branch.slice("refs/heads/".length)}`;
  const [remote, merge] = await Promise.all([
    git(directory, ["config", "--local", "--no-includes", "--null", "--get-all", `${key}.remote`], true),
    git(directory, ["config", "--local", "--no-includes", "--null", "--get-all", `${key}.merge`], true),
  ]);
  if (remote === undefined || merge === undefined) return "unavailable";
  return remote === "" || merge === "" ? "unbound" : "bound";
}

async function localValue(git: LocalGit, directory: string, key: string): Promise<string | undefined> {
  const output = await git(directory, ["config", "--local", "--no-includes", "--null", "--get-all", key]);
  const match = output && /^([^\u0000-\u001f\u007f]+)\0$/u.exec(output);
  return match ? match[1] : undefined;
}

async function readUpstream(git: LocalGit, directory: string): Promise<Upstream | undefined> {
  const branch = (await git(directory, ["symbolic-ref", "--quiet", "HEAD"]))?.trimEnd();
  if (!branch?.startsWith("refs/heads/")) return;
  const key = `branch.${branch.slice("refs/heads/".length)}`;
  const [remote, merge] = await Promise.all([
    localValue(git, directory, `${key}.remote`), localValue(git, directory, `${key}.merge`),
  ]);
  if (!remote || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remote) || !merge?.startsWith("refs/heads/") ||
      await git(directory, ["check-ref-format", merge]) === undefined) return;

  const [url, effectiveUrl] = await Promise.all([
    localValue(git, directory, `remote.${remote}.url`), git(directory, ["remote", "get-url", "--all", remote]),
  ]);
  if (!url || effectiveUrl !== `${url}\n` || /^[+-]/u.test(url) || /^[^/:]+::/u.test(url)) return;
  const protocol = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(url)?.[1];
  if (protocol && !["file", "git", "http", "https", "ssh"].includes(protocol)) return;
  return { branch, remote, merge, url };
}

function upstreamFingerprint(upstream: Upstream): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(upstream)).digest("hex");
}

export async function updateBindingFingerprint(git: LocalGit, directory: string): Promise<string | undefined> {
  const upstream = await readUpstream(git, directory);
  return upstream && upstreamFingerprint(upstream);
}

export async function isUpdateWorktreeDirty(git: LocalGit, directory: string): Promise<boolean | undefined> {
  const settings = await git(directory, ["config", "--name-only", "--null", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], true);
  if (settings === undefined) return;
  const filters = new Set(settings.split("\0").flatMap((key) => {
    const name = /^filter\.(.+)\.(?:clean|process|required)$/u.exec(key)?.[1];
    return name ? [name] : [];
  }));
  const disabled = [...filters].flatMap((name) => [
    "-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`,
  ]);
  const status = await git(directory, [...disabled, "status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=dirty"]);
  return status === undefined ? undefined : status.length > 0;
}

async function fetchUpstream(
  directory: string, upstream: Upstream, ref: string, signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const git = Bun.which("git");
  if (!git) return false;
  try {
    return await runUpdateProcess(directory, {
      PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes",
    }, [git, "--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`,
      "-c", "credential.helper=", "-c", "core.askPass=", "-c", "http.followRedirects=false",
      "-c", "fetch.writeCommitGraph=false", "-c", "fetch.bundleURI=", "-c", "transfer.bundleURI=false",
      "fetch", "--atomic", "--quiet", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules",
      "--no-write-fetch-head", "--no-auto-gc", "--refmap=", "--upload-pack=git-upload-pack", "--",
      upstream.remote, `${upstream.merge}:${ref}`], 45_000, signal);
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function releaseRef(directory: string, ref: string): () => Promise<void> {
  let released = false;
  let removing: Promise<void> | undefined;
  return async () => {
    if (released) return;
    return removing ??= (async () => {
      const git = createLocalGit();
      if (!git || !await isGitCheckout(git, directory) ||
          await git(directory, ["update-ref", "--no-deref", "-d", ref]) === undefined) {
        throw new Error("无法清除临时更新引用。");
      }
      released = true;
    })().finally(() => { removing = undefined; });
  };
}

export async function fetchUpdateCandidate(directory: string, signal?: AbortSignal, force = false): Promise<UpdateCandidateResult> {
  signal?.throwIfAborted();
  const unavailable = { status: "unavailable" } as const;
  const dirtyResult = { status: "dirty" } as const;
  const git = createLocalGit();
  if (!git) return unavailable;

  try {
    const checkout = await realpath(directory);
    const valid = checkout === resolve(directory) && await isGitCheckout(git, checkout);
    signal?.throwIfAborted();
    if (!valid) return unavailable;
    const [upstream, current, dirty] = await Promise.all([
      readUpstream(git, checkout), gitHead(git, checkout), isUpdateWorktreeDirty(git, checkout),
    ]);
    signal?.throwIfAborted();
    if (!force && dirty === true) return dirtyResult;
    if (!upstream || !current || dirty === undefined) return unavailable;

    const ref = `refs/lotus-yunzai/update/${crypto.randomUUID()}`;
    const release = releaseRef(checkout, ref);
    let handoff = false;
    try {
      if (!await fetchUpstream(checkout, upstream, ref, signal)) return unavailable;
      const inspect = createLocalGit();
      const valid = inspect && await isGitCheckout(inspect, checkout);
      signal?.throwIfAborted();
      if (!inspect || !valid) return unavailable;
      const [output, latest, latestUpstream, latestDirty] = await Promise.all([
        inspect(checkout, ["rev-parse", "--verify", `${ref}^{commit}`]), gitHead(inspect, checkout),
        readUpstream(inspect, checkout), isUpdateWorktreeDirty(inspect, checkout),
      ]);
      signal?.throwIfAborted();
      if (!force && latestDirty === true) return dirtyResult;
      if (latestDirty === undefined || latest !== current || latestUpstream?.branch !== upstream.branch ||
          latestUpstream.remote !== upstream.remote || latestUpstream.merge !== upstream.merge ||
          latestUpstream.url !== upstream.url) return unavailable;
      const candidate = output?.trim();
      if (!candidate || !isGitRevision(candidate)) return unavailable;

      let status: "ready" | "current" | "ahead" | "diverged" = "current";
      if (force) {
        if (candidate !== current || latestDirty) status = "ready";
      } else if (candidate !== current) {
        const output = await inspect(checkout, ["merge-base", current, candidate], true);
        signal?.throwIfAborted();
        if (output === undefined) return unavailable;
        const base = output.trim();
        status = base === current ? "ready" : base === candidate ? "ahead" : "diverged";
      }
      signal?.throwIfAborted();
      const binding = status === "ready" ? upstreamFingerprint(upstream) : undefined;
      handoff = true;
      return { status, current, candidate, ...(binding === undefined ? {} : { binding }), release };
    } finally {
      if (!handoff) await release();
    }
  } catch {
    signal?.throwIfAborted();
    return unavailable;
  }
}
