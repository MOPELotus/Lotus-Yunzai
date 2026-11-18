import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareUpdate } from "../lib/update-preflight.ts";

const noGit = !Bun.which("git");
const pluginDirectory = "weather-Plugin";
const pluginPackage = "@fixture/weather";
const siblingPackage = "@fixture/sibling";

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

async function withTemporary(run: (temporary: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-update-preflight-"));
  try {
    await run(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function head(directory: string) {
  return git(directory, "rev-parse", "HEAD");
}

function refs(directory: string) {
  return git(directory, "for-each-ref", "--format=%(refname) %(objectname)");
}

async function createRemote(temporary: string, name: string, files: Record<string, string>, modules?: { system: string }) {
  const remote = join(temporary, `${name}.git`);
  const writer = join(temporary, `${name}-writer`);
  git(temporary, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  git(temporary, "init", "--quiet", "--initial-branch=main", writer);
  await Promise.all(Object.entries(files).map(([path, content]) => writeFile(join(writer, path), content)));
  if (modules) git(writer, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", modules.system, "plugins/system");
  git(writer, "add", "--all");
  git(writer, "commit", "--quiet", "-m", "Fixture baseline");
  git(writer, "remote", "add", "origin", remote);
  git(writer, "push", "--quiet", "-u", "origin", "main");
  return { remote, writer };
}

function publish(writer: string, summary: string) {
  git(writer, "add", "--all");
  git(writer, "commit", "--quiet", "-m", summary);
  git(writer, "push", "--quiet", "origin", "main");
  return head(writer);
}

function requireReady(result: Awaited<ReturnType<typeof prepareUpdate>>) {
  if (result.status !== "ready") throw new Error(`预检未得到可用候选，实际结果为 ${JSON.stringify(result)}。`);
  return result;
}

const pluginManifest = (name: string, games?: readonly string[]) => JSON.stringify({
  name, type: "module", lotusYunzai: { entry: "./index.js", games },
});
const pluginEntry = 'export default { commands: {} };\n';

test.skipIf(noGit)("预检宿主与内置模块只返回候选和差异，释放后恢复全部引用", () => withTemporary(async (temporary) => {
  const system = await createRemote(temporary, "fixture-system", {
    "package.json": pluginManifest("@lotus-yunzai/system"), "index.js": pluginEntry,
  });
  const remote = await createRemote(temporary, "fixture-host", {
    "package.json": JSON.stringify({ name: "lotus-yunzai", private: true }),
    "app.ts": 'export const marker = "baseline";\n',
  }, { system: system.remote });
  const checkout = join(temporary, "host");
  git(temporary, "clone", "--quiet", "--no-local", remote.remote, checkout);
  git(checkout, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet");
  const initial = head(checkout);
  const initialRefs = refs(checkout);
  const baseline = await readFile(join(checkout, "app.ts"), "utf8");
  const source = pathToFileURL(`${checkout}/`);
  const directories = new Map([["system", { path: join(checkout, "plugins/system"), packageName: "@lotus-yunzai/system" }]]);

  await Promise.all([
    writeFile(join(remote.writer, "app.ts"), 'export const marker = "candidate";\n'),
    writeFile(join(remote.writer, "fixture-candidate.txt"), "candidate-only\n"),
  ]);
  const next = publish(remote.writer, "Fixture host candidate");

  for (const requested of [undefined, "system", "@lotus-yunzai/system"]) {
    const result = requireReady(await prepareUpdate(source, directories, requested));
    try {
      expect(result).toMatchObject({ scope: "host", name: "Lotus-Yunzai", current: initial, candidate: next });
      expect([...result.changedPaths].sort()).toEqual(["app.ts", "fixture-candidate.txt"]);
      expect(head(checkout)).toBe(initial);
      expect(await readFile(join(checkout, "app.ts"), "utf8")).toBe(baseline);
      expect(await Bun.file(join(checkout, "fixture-candidate.txt")).exists()).toBe(false);
    } finally {
      await result.release();
    }
    expect(refs(checkout)).toBe(initialRefs);
    expect(git(checkout, "status", "--porcelain")).toBe("");
  }
}));

test.skipIf(noGit)("外部插件预检支持旧短别名，只检查候选清单且不执行入口", () => withTemporary(async (temporary) => {
  const host = await createRemote(temporary, "fixture-host", {
    "package.json": JSON.stringify({ name: "lotus-yunzai", private: true }), ".gitignore": "/plugins/\n",
  });
  const checkout = join(temporary, "host");
  git(temporary, "clone", "--quiet", "--no-local", host.remote, checkout);
  const plugin = await createRemote(temporary, "fixture-plugin", {
    "package.json": pluginManifest(pluginPackage), "index.js": pluginEntry,
  });
  const sibling = await createRemote(temporary, "fixture-sibling", {
    "package.json": pluginManifest(siblingPackage), "index.js": pluginEntry,
  });
  const plugins = join(checkout, "plugins");
  await mkdir(plugins);
  const path = join(plugins, pluginDirectory);
  const siblingPath = join(plugins, "sibling");
  git(plugins, "clone", "--quiet", "--no-local", plugin.remote, path);
  git(plugins, "clone", "--quiet", "--no-local", sibling.remote, siblingPath);
  const directories = new Map([
    [pluginDirectory, { path, packageName: pluginPackage }],
    ["sibling", { path: siblingPath, packageName: siblingPackage }],
  ]);
  const initial = head(path);
  const initialRefs = refs(path);
  const source = pathToFileURL(`${checkout}/`);
  const executed = join(temporary, "fixture-entry-ran");
  await writeFile(join(plugin.writer, "index.js"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(executed)}, "candidate entry ran");
    ${pluginEntry}
  `);
  const next = publish(plugin.writer, "Fixture candidate entry");
  const ready = requireReady(await prepareUpdate(source, directories, "weather"));
  try {
    expect(ready).toMatchObject({ scope: "plugin", name: pluginDirectory, current: initial, candidate: next });
    expect(ready.changedPaths).toEqual(["index.js"]);
    expect(await Bun.file(executed).exists()).toBe(false);
  } finally {
    await ready.release();
  }
  expect(refs(path)).toBe(initialRefs);

  for (const [summary, manifest] of [
    ["Fixture disallowed game", pluginManifest(pluginPackage, ["wuwa"])],
    ["Fixture duplicate plugin", pluginManifest(siblingPackage)],
  ] as const) {
    await writeFile(join(plugin.writer, "package.json"), manifest);
    publish(plugin.writer, summary);
    expect((await prepareUpdate(source, directories, "weather")).status).toBe("rejected");
    expect(head(path)).toBe(initial);
    expect(refs(path)).toBe(initialRefs);
    expect(await readFile(join(path, "index.js"), "utf8")).toBe(pluginEntry);
    expect(await Bun.file(executed).exists()).toBe(false);
    expect(git(path, "status", "--porcelain")).toBe("");
  }
}));

test.skipIf(noGit)("预检区分无更新、未提交修改、本地领先与分支分叉，并清理引用", () => withTemporary(async (temporary) => {
  const host = await createRemote(temporary, "fixture-host", {
    "package.json": JSON.stringify({ name: "lotus-yunzai", private: true }), "tracked.txt": "baseline\n",
  });
  const checkout = join(temporary, "host");
  git(temporary, "clone", "--quiet", "--no-local", host.remote, checkout);
  const root = pathToFileURL(`${checkout}/`);

  async function expectStatus(expected: "current" | "dirty" | "ahead" | "diverged" | "unavailable") {
    const oldHead = head(checkout);
    const oldRefs = refs(checkout);
    const result = await prepareUpdate(root, new Map());
    try {
      expect(result.status).toBe(expected);
      expect(head(checkout)).toBe(oldHead);
    } finally {
      if (result.status === "ready") await result.release();
    }
    expect(refs(checkout)).toBe(oldRefs);
  }

  await expectStatus("current");
  const trackedFile = join(checkout, "tracked.txt");
  await writeFile(trackedFile, "local edit\n");
  await expectStatus("dirty");
  expect(await readFile(trackedFile, "utf8")).toBe("local edit\n");

  git(checkout, "add", "tracked.txt");
  git(checkout, "commit", "--quiet", "-m", "Fixture local change");
  await expectStatus("ahead");

  await writeFile(join(host.writer, "tracked.txt"), "remote edit\n");
  publish(host.writer, "Fixture remote change");
  await expectStatus("diverged");
  git(checkout, "switch", "--detach", "--quiet");
  await expectStatus("unavailable");
}));
