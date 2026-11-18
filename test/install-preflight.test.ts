import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { devNull, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { ApprovedInstall } from "../lib/install-catalog.ts";

const gitBinary = Bun.which("git");
const branch = "release/demo";
const url = "https://example.invalid/fixture/plugin.git";
const preflightModule = new URL("../lib/install-preflight.ts", import.meta.url).href;

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    gitBinary!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", ...args,
  ], { cwd: directory, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}

async function gitFixture(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-install-preflight-"));
  try {
    await run(await createFixture(temporary));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function createFixture(directory: string) {
  const host = join(directory, "host");
  const remote = join(directory, "remote");
  const staging = join(directory, "staging");
  const tools = join(directory, "bin");
  const trace = join(directory, "git.log");
  const escaped = JSON.stringify;
  await Promise.all([host, remote, staging, tools].map((path) => mkdir(path)));
  git(host, "init", "--quiet", "--initial-branch=main");
  git(host, "commit", "--quiet", "--allow-empty", "-m", "Host baseline");
  git(remote, "init", "--quiet", `--initial-branch=${branch}`);
  git(remote, "commit", "--quiet", "--allow-empty", "-m", "Plugin ancestor");
  const ancestor = git(remote, "rev-parse", "HEAD");
  await mkdir(join(remote, "config"));
  await writeFile(join(remote, "config/default.json"), "{}\n");
  await writeFile(join(remote, "index.js"), "throw new Error('预检不能运行入口');\n");

  await writeFile(join(tools, "git"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const command = args.find((arg) => ["fetch", "checkout", "ls-tree"].includes(arg));
if (command && process.cwd().startsWith(${escaped(staging + "/")})) appendFileSync(${escaped(trace)}, command + "\\n");
const env = { ...process.env };
if (command === "fetch") {
  if (args.at(-2) !== "origin" || args.at(-1) !== ${escaped(`refs/heads/${branch}:refs/remotes/origin/${branch}`)} ||
      !args.includes("http.followRedirects=false") || !args.includes("--no-recurse-submodules") ||
      env.GIT_ALLOW_PROTOCOL !== "https" || env.GIT_CONFIG_GLOBAL !== ${escaped(devNull)} ||
      env.GIT_TERMINAL_PROMPT !== "0" || env.HOME !== process.cwd() ||
      env.SSH_AUTH_SOCK || env.HTTPS_PROXY) throw new Error("安装拉取隔离参数无效");
  args[args.length - 2] = ${escaped(pathToFileURL(remote).href)};
  env.GIT_ALLOW_PROTOCOL = "file";
}
const result = Bun.spawnSync([${escaped(gitBinary)}, ...args], { env, stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode);
`, { mode: 0o700 });

  function commit() {
    git(remote, "add", "--all");
    git(remote, "commit", "--quiet", "-m", "Plugin fixture");
    return git(remote, "rev-parse", "HEAD");
  }

  async function prepare(
    revision: string, overrides?: Partial<ApprovedInstall>, plugins?: readonly [string, { path: string; packageName: string }][],
  ) {
    const approved: ApprovedInstall = { name: "演示插件", directory: "fixture-plugin", url, branch, revision, ...overrides };
    const program = `
      import { preparePluginInstall } from ${escaped(preflightModule)};
      import { stat } from "node:fs/promises";
      const input = JSON.parse(process.env.LOTUS_INSTALL_TEST_INPUT);
      const result = await preparePluginInstall(new URL(input.host), new Map(input.plugins), input.approved, input.staging);
      if (result.status !== "ready") console.log(JSON.stringify(result));
      else {
        const { source } = result.plugin;
        try {
          const git = (...args) => {
            const result = Bun.spawnSync([${escaped(gitBinary)}, ...args], { cwd: source });
            if (result.exitCode !== 0) throw new Error(result.stderr.toString());
            return result.stdout.toString().trim();
          };
          console.log(JSON.stringify({
            ...result, frozenApproval: Object.isFrozen(result.approval), mode: (await stat(source)).mode & 511,
            upstream: git("rev-parse", "--abbrev-ref", "@{upstream}"), branch: git("symbolic-ref", "--short", "HEAD"),
            head: git("rev-parse", "HEAD"), origin: git("remote", "get-url", "origin"),
            commits: git("rev-list", "--count", "HEAD"),
          }));
        } finally {
          await result.release();
          await result.release();
        }
      }
    `;
    await writeFile(trace, "");
    const child = Bun.spawn([process.execPath, "-e", program], {
      stdout: "pipe", stderr: "pipe",
      env: {
        PATH: [tools, process.env.PATH].join(delimiter), HTTPS_PROXY: "dummy-for-test", SSH_AUTH_SOCK: "dummy-for-test",
        LOTUS_INSTALL_TEST_INPUT: JSON.stringify({ host: pathToFileURL(host).href, approved, staging, plugins: plugins ?? [] }),
      },
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(errors);
    expect(await readdir(staging)).toEqual([]);
    return { result: JSON.parse(output), commands: (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean) };
  }

  return { host, remote, ancestor, prepare, commit };
}

const unsupported = !gitBinary || process.platform === "win32";

test.skipIf(unsupported)("安装预检保留审核的提交历史、远端和跟踪分支，只在审核后检出", () => gitFixture(async ({
  host, remote, prepare, commit,
}) => {
  await writeFile(join(remote, "package.json"), JSON.stringify({ name: "@fixture/approved", lotusYunzai: { entry: "index.js" } }));
  const revision = commit();
  const { result, commands } = await prepare(revision);
  expect(result).toMatchObject({
    status: "ready", scope: "install", frozenApproval: true, mode: 0o700,
    approval: { name: "演示插件", directory: "fixture-plugin", url, branch, revision },
    host: { directory: host, current: git(host, "rev-parse", "HEAD") },
    plugin: { name: "fixture-plugin", revision }, head: revision, branch,
    origin: url, upstream: `origin/${branch}`, commits: "2",
  });
  expect(commands).toEqual(["fetch", "ls-tree", "checkout"]);
  expect(git(host, "status", "--porcelain")).toBe("");
}));

test.skipIf(unsupported)("安装预检拒绝变动的上游固定提交、已归并候选和重复身份", () => gitFixture(async ({
  host, remote, ancestor, prepare, commit,
}) => {
  const manifest = join(remote, "package.json");
  await writeFile(manifest, JSON.stringify({ name: "@fixture/approved", lotusYunzai: { entry: "index.js" } }));
  let revision = commit();
  expect(await prepare(revision, { url: "https://git.trss.me/Yunzai-genshin" }))
    .toEqual({ result: { status: "rejected" }, commands: [] });
  expect(await prepare(revision, { name: "Yunzai-genshin" })).toEqual({ result: { status: "rejected" }, commands: [] });
  expect(await prepare(revision, { directory: "miao-plugin" })).toEqual({ result: { status: "rejected" }, commands: [] });
  expect(await prepare(ancestor)).toEqual({ result: { status: "rejected" }, commands: ["fetch"] });
  const peer = join(host, "plugins/peer");
  await mkdir(peer, { recursive: true });
  await writeFile(join(peer, "package.json"), JSON.stringify({ name: "@fixture/approved" }));
  expect(await prepare(revision, undefined, [["peer", { path: peer, packageName: "@fixture/approved" }]]))
    .toEqual({ result: { status: "rejected" }, commands: ["fetch", "ls-tree"] });
  await writeFile(manifest, JSON.stringify({ name: "@fixture/approved", lotusYunzai: { entry: "index.js", games: ["wuwa"] } }));
  revision = commit();
  expect(await prepare(revision)).toEqual({ result: { status: "rejected" }, commands: ["fetch", "ls-tree"] });
}));

test.skipIf(unsupported)("安装预检保护已占用目录和运行状态路径", () => gitFixture(async ({
  host, remote, prepare, commit,
}) => {
  await writeFile(join(remote, ".env.sample"), "EXAMPLE=1\n");
  let revision = commit();
  expect(await prepare(revision)).toEqual({ result: { status: "rejected" }, commands: ["fetch", "ls-tree"] });

  git(remote, "rm", "--", ".env.sample");
  git(remote, "rm", "-r", "--", "config");
  await symlink("../missing", join(remote, "config"));
  revision = commit();
  expect(await prepare(revision)).toEqual({ result: { status: "rejected" }, commands: ["fetch", "ls-tree"] });

  await mkdir(join(host, "plugins"));
  await symlink(join(host, "missing"), join(host, "plugins/fixture-plugin"));
  expect(await prepare(revision)).toEqual({ result: { status: "exists" }, commands: [] });
  expect(await prepare(revision, { url: "https://user:secret@example.invalid/fixture/plugin.git" }))
    .toEqual({ result: { status: "rejected" }, commands: [] });
  await rm(join(host, "plugins/fixture-plugin"));
  await writeFile(join(host, "plugins/fixture-plugin"), "已被宿主跟踪");
  git(host, "add", "--all");
  git(host, "commit", "--quiet", "-m", "Host occupies install path");
  await rm(join(host, "plugins/fixture-plugin"));
  expect(await prepare(revision)).toEqual({ result: { status: "exists" }, commands: [] });
}));
