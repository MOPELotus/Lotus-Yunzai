import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLocalGit } from "../lib/local-git.ts";
import { updateBindingFingerprint } from "../lib/update-candidate-git.ts";
import { prepareAllUpdates, prepareUpdate } from "../lib/update-preflight.ts";

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

test.skipIf(noGit)("网络拉取耗时超过本地 Git 查询预算仍可读到候选差异", () => withTemporary(async (temporary) => {
  const remote = await createRemote(temporary, "slow-host", { "tracked.txt": "baseline\n" });
  const checkout = join(temporary, "host");
  git(temporary, "clone", "--quiet", "--no-local", remote.remote, checkout);
  await writeFile(join(remote.writer, "tracked.txt"), "candidate\n");
  const candidate = publish(remote.writer, "Fixture candidate");
  git(remote.remote, "update-server-info");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/info/refs") await Bun.sleep(1_700);
      if (!/^\/(?:info\/refs|HEAD|objects\/[a-z0-9/.-]+)$/u.test(path) || path.split("/").includes("..")) {
        return new Response(null, { status: 404 });
      }
      const file = Bun.file(join(remote.remote, path.slice(1)));
      return await file.exists() ? new Response(file, { headers: { "Content-Type": "application/octet-stream" } })
        : new Response(null, { status: 404 });
    },
  });
  try {
    git(checkout, "remote", "set-url", "origin", server.url.origin);
    const ready = requireReady(await prepareUpdate(pathToFileURL(`${checkout}/`), new Map()));
    try {
      expect(ready.candidate).toBe(candidate);
      expect(ready.changedPaths).toEqual(["tracked.txt"]);
    } finally {
      await ready.release();
    }
  } finally {
    await server.stop(true);
  }
}), 10_000);

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

  async function expectStatus(expected: "current" | "dirty" | "ahead" | "diverged" | "unavailable", force = false) {
    const oldHead = head(checkout);
    const oldRefs = refs(checkout);
    const result = await prepareUpdate(root, new Map(), undefined, undefined, force);
    try {
      expect(result.status).toBe(expected);
      expect(head(checkout)).toBe(oldHead);
    } finally {
      if (result.status === "ready") await result.release();
    }
    expect(refs(checkout)).toBe(oldRefs);
  }

  async function expectForcedCandidate(candidate: string, changedPaths: readonly string[]) {
    const oldHead = head(checkout);
    const oldRefs = refs(checkout);
    const ready = requireReady(await prepareUpdate(root, new Map(), undefined, undefined, true));
    try {
      expect(ready).toMatchObject({ force: true, current: oldHead, candidate, changedPaths });
      expect(ready.binding).toMatch(/^[0-9a-f]{64}$/u);
      expect(await updateBindingFingerprint(createLocalGit()!, checkout)).toBe(ready.binding);
      expect(head(checkout)).toBe(oldHead);
    } finally {
      await ready.release();
    }
    expect(refs(checkout)).toBe(oldRefs);
  }

  const initial = head(checkout);
  await expectStatus("current");
  await expectStatus("current", true);
  const trackedFile = join(checkout, "tracked.txt");
  await writeFile(trackedFile, "staged edit\n");
  git(checkout, "add", "tracked.txt");
  await writeFile(trackedFile, "local edit\n");
  await expectStatus("dirty");
  await expectForcedCandidate(initial, []);
  expect(git(checkout, "show", ":tracked.txt")).toBe("staged edit");
  expect(await readFile(trackedFile, "utf8")).toBe("local edit\n");

  git(checkout, "add", "tracked.txt");
  git(checkout, "commit", "--quiet", "-m", "Fixture local change");
  await expectStatus("ahead");
  await expectForcedCandidate(initial, ["tracked.txt"]);

  await writeFile(join(host.writer, "tracked.txt"), "remote edit\n");
  const remote = publish(host.writer, "Fixture remote change");
  await expectStatus("diverged");
  await expectForcedCandidate(remote, ["tracked.txt"]);
  git(checkout, "switch", "--detach", "--quiet");
  await expectStatus("unavailable");
  await expectStatus("unavailable", true);
}));

test.skipIf(noGit)("批量预检按最终集合校验插件身份，并释放所有候选引用", () => withTemporary(async (temporary) => {
  const host = await createRemote(temporary, "host", { "app.ts": "export {};\n", ".gitignore": "/plugins/\n" });
  const first = await createRemote(temporary, "first", {
    "package.json": pluginManifest(pluginPackage), "index.js": pluginEntry,
  });
  const second = await createRemote(temporary, "second", {
    "package.json": pluginManifest(siblingPackage), "index.js": pluginEntry,
  });
  const checkout = join(temporary, "checkout");
  const root = pathToFileURL(`${checkout}/`);
  const paths = [checkout, join(checkout, "plugins/first"), join(checkout, "plugins/second")] as const;
  for (const [index, { remote }] of [host, first, second].entries()) git(temporary, "clone", "--quiet", remote, paths[index]!);
  const directories = new Map([
    ["first", { path: paths[1], packageName: pluginPackage }],
    ["second", { path: paths[2], packageName: siblingPackage }],
  ]);
  const initialHeads = paths.map(head);
  const initialRefs = paths.map(refs);

  await writeFile(join(host.writer, "app.ts"), "export const marker = 1;\n");
  const hostCandidate = publish(host.writer, "Advance host");
  await writeFile(join(first.writer, "package.json"), pluginManifest(siblingPackage));
  const firstCandidate = publish(first.writer, "Rename first plugin");
  expect(await prepareAllUpdates(root, directories)).toEqual({ status: "rejected", target: "first" });
  expect(paths.map(refs)).toEqual(initialRefs);

  await writeFile(join(second.writer, "package.json"), pluginManifest(pluginPackage));
  const secondCandidate = publish(second.writer, "Rename second plugin");
  const result = await prepareAllUpdates(root, directories);
  if (result.status !== "ready") throw new Error(`批量预检失败：${JSON.stringify(result)}。`);
  try {
    expect(result.host).toEqual({ directory: checkout, current: initialHeads[0]!, candidate: hostCandidate,
      binding: await updateBindingFingerprint(createLocalGit()!, checkout) });
    expect([...result.plugins].map(([name, plugin]) => [name, plugin.candidate])).toEqual([
      ["first", firstCandidate], ["second", secondCandidate],
    ]);
    expect(paths.map(head)).toEqual(initialHeads);
  } finally {
    await result.release();
    await result.release();
  }
  expect(paths.map(refs)).toEqual(initialRefs);

  for (const plugin of [first, second]) {
    await writeFile(join(plugin.writer, "package.json"), pluginManifest("@fixture/new-shared-name"));
    publish(plugin.writer, "Claim shared new identity");
  }
  expect(await prepareAllUpdates(root, directories)).toEqual({ status: "rejected", target: "second" });
  expect(paths.map(refs)).toEqual(initialRefs);
}));

test.skipIf(noGit)("全量强制预检标记同提交的脏目标，继续拒绝上游不合规插件", () => withTemporary(async (temporary) => {
  const host = await createRemote(temporary, "host", { "app.ts": "export {};\n", ".gitignore": "/plugins/\n" });
  const plugin = await createRemote(temporary, "plugin", {
    "package.json": pluginManifest(pluginPackage), "index.js": pluginEntry,
  });
  const checkout = join(temporary, "checkout");
  const path = join(checkout, "plugins/external");
  git(temporary, "clone", "--quiet", host.remote, checkout);
  git(temporary, "clone", "--quiet", plugin.remote, path);
  const root = pathToFileURL(`${checkout}/`);
  const directories = new Map([["external", { path, packageName: pluginPackage }]]);
  const hostHead = head(checkout);
  const pluginHead = head(path);
  const initialRefs = [checkout, path].map(refs);

  await writeFile(join(checkout, "app.ts"), "export const local = true;\n");
  expect(await prepareAllUpdates(root, directories)).toEqual({ status: "dirty", target: "Lotus-Yunzai" });
  const result = await prepareAllUpdates(root, directories, undefined, true);
  if (result.status !== "ready") throw new Error(`全量强制预检失败：${JSON.stringify(result)}。`);
  try {
    expect(result.force).toBe(true);
    expect(result.host).toMatchObject({ force: true, current: hostHead, candidate: hostHead });
    expect(result.host.binding).toBe(await updateBindingFingerprint(createLocalGit()!, checkout));
    expect(result.plugins.size).toBe(0);
  } finally {
    await result.release();
  }

  git(checkout, "restore", "app.ts");
  await writeFile(join(path, "index.js"), `${pluginEntry}\nexport const local = true;\n`);
  const pluginOnly = await prepareAllUpdates(root, directories, undefined, true);
  if (pluginOnly.status !== "ready") throw new Error(`全量强制预检失败：${JSON.stringify(pluginOnly)}。`);
  try {
    expect(pluginOnly.host.force).toBeUndefined();
    expect(pluginOnly.plugins.get("external")).toMatchObject({ force: true, current: pluginHead, candidate: pluginHead });
  } finally {
    await pluginOnly.release();
  }

  await writeFile(join(plugin.writer, "package.json"), pluginManifest(pluginPackage, ["wuwa"]));
  publish(plugin.writer, "Disallowed upstream plugin");
  expect(await prepareAllUpdates(root, directories, undefined, true)).toEqual({ status: "rejected", target: "external" });
  expect(await prepareUpdate(root, directories, "external", undefined, true)).toEqual({ status: "rejected" });
  expect([checkout, path].map(refs)).toEqual(initialRefs);
}));

test.skipIf(noGit)("批量预检保持领先宿主、跳过无绑定插件，并标记已绑定仓库失败", () => withTemporary(async (temporary) => {
  const embedded = await createRemote(temporary, "embedded", {
    "package.json": pluginManifest("@fixture/embedded"), "index.js": pluginEntry,
  });
  const host = await createRemote(temporary, "host", { "app.ts": "export {};\n" });
  git(host.writer, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", embedded.remote, "plugins/embedded");
  publish(host.writer, "Track embedded plugin");
  const checkout = join(temporary, "checkout");
  git(temporary, "clone", "--quiet", host.remote, checkout);
  git(checkout, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet");
  git(checkout, "commit", "--allow-empty", "--quiet", "-m", "Local host commit");
  const hostHead = head(checkout);
  const root = pathToFileURL(`${checkout}/`);
  const pluginPath = join(checkout, "plugins/external");
  const detachedPath = join(checkout, "plugins/detached");
  const localPath = join(checkout, "plugins/local");
  const embeddedPath = join(checkout, "plugins/embedded");
  const unboundPath = join(checkout, "plugins/unbound");
  const external = await createRemote(temporary, "external", {
    "package.json": pluginManifest(pluginPackage), "index.js": pluginEntry,
  });
  for (const path of [pluginPath, detachedPath, unboundPath]) git(temporary, "clone", "--quiet", external.remote, path);
  for (const [path, name] of [[detachedPath, "detached"], [unboundPath, "unbound"]] as const) {
    await writeFile(join(path, "package.json"), pluginManifest(`@fixture/${name}`));
    git(path, "commit", "-am", `Rename ${name} fixture`);
  }
  git(detachedPath, "switch", "--quiet", "--detach");
  git(unboundPath, "branch", "--unset-upstream");
  await mkdir(localPath);
  git(embeddedPath, "switch", "--quiet", "-c", "independent");
  git(embeddedPath, "config", "branch.independent.remote", "origin");
  git(embeddedPath, "config", "branch.independent.merge", "refs/heads/main");
  git(embeddedPath, "remote", "set-url", "origin", join(temporary, "missing.git"));
  const directories = new Map([
    ["external", { path: pluginPath, packageName: pluginPackage }],
    ["detached", { path: detachedPath, packageName: "@fixture/detached" }],
    ["unbound", { path: unboundPath, packageName: "@fixture/unbound" }],
    ["local", { path: localPath, packageName: "local" }],
    ["embedded", { path: embeddedPath, packageName: "@fixture/embedded" }],
  ]);
  const initialRefs = [checkout, pluginPath].map(refs);
  expect(await prepareAllUpdates(root, directories)).toEqual({ status: "current" });
  expect([checkout, pluginPath].map(refs)).toEqual(initialRefs);

  await writeFile(join(external.writer, "index.js"), `${pluginEntry}\nexport const marker = 1;\n`);
  const candidate = publish(external.writer, "Advance external plugin");
  const result = await prepareAllUpdates(root, directories);
  if (result.status !== "ready") throw new Error(`批量预检失败：${JSON.stringify(result)}。`);
  try {
    expect(result.host).toMatchObject({ current: hostHead, candidate: hostHead });
    expect([...result.plugins].map(([name, plugin]) => [name, plugin.candidate])).toEqual([["external", candidate]]);
  } finally {
    await result.release();
  }
  expect([checkout, pluginPath].map(refs)).toEqual(initialRefs);

  await writeFile(join(unboundPath, "index.js"), "// dirty\n");
  expect(await prepareAllUpdates(root, directories)).toEqual({ status: "dirty", target: "unbound" });
  expect([checkout, pluginPath].map(refs)).toEqual(initialRefs);
  git(unboundPath, "restore", "index.js");
  git(unboundPath, "branch", "--set-upstream-to=origin/main");
  git(unboundPath, "remote", "set-url", "origin", join(temporary, "missing.git"));
  expect(await prepareAllUpdates(root, directories)).toEqual({ status: "unavailable", target: "unbound" });
  expect([checkout, pluginPath].map(refs)).toEqual(initialRefs);

  const controller = new AbortController();
  const abort = new Error("Cancel batch fixture");
  const served = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      served.resolve();
      await finish.promise;
      return new Response(null, { status: 404 });
    },
  });
  try {
    git(unboundPath, "remote", "set-url", "origin", server.url.origin);
    const pending = prepareAllUpdates(root, directories, controller.signal);
    try {
      const fetching = await Promise.race([served.promise.then(() => true), pending.then(() => false)]);
      expect(fetching).toBe(true);
      expect(refs(pluginPath)).toContain("refs/lotus-yunzai/update/");
      controller.abort(abort);
      await expect(pending).rejects.toBe(abort);
      expect([checkout, pluginPath].map(refs)).toEqual(initialRefs);
      expect(refs(unboundPath)).not.toContain("refs/lotus-yunzai/update/");
    } finally {
      controller.abort(abort);
      await pending.catch(() => {});
    }
  } finally {
    finish.resolve();
    await server.stop(true);
  }
}));
