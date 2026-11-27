import { expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildExternalPluginCheckout, buildUpdateCheckout, initializeUpdateSubmodules, runUpdateProcess } from "../lib/update-build.ts";

test("source compilation can extend the update deadline once while ordinary hangs still expire", async () => {
  const command = [process.execPath, "-e", "setTimeout(()=>process.exit(0),100)"];
  let extensions = 0;
  expect(await runUpdateProcess(process.cwd(), {}, command, 30, undefined, undefined,
    { timeout: 300, enabled: async () => { extensions++; return true; } })).toBe(true);
  expect(extensions).toBe(1);
  expect(await runUpdateProcess(process.cwd(), {}, command, 30, undefined, undefined,
    { timeout: 300, enabled: async () => false })).toBe(false);
});

async function fixture(run: (root: string, checkout: string, cache: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-update-build-"));
  const checkout = join(root, "checkout");
  try {
    await mkdir(join(checkout, "scripts"), { recursive: true });
    await run(root, checkout, join(root, "cache"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("候选实际运行初始化和 typecheck，隔离宿主环境和本地缓存", () => fixture(async (_root, checkout, cache) => {
  const secretKey = "LOTUS_UPDATE_TEST_HOST_SECRET";
  const previous = process.env[secretKey];
  process.env[secretKey] = "host-only test value";
  try {
    await writeFile(join(checkout, ".env"), "LOTUS_UPDATE_TEST_DOTENV=fixture-only\n");
    await writeFile(join(checkout, "package.json"), JSON.stringify({ scripts: { typecheck: "bun run --no-env-file scripts/check.ts" } }));
    const checkEnv = `
      import assert from "node:assert/strict";
      assert.equal(process.cwd(), ${JSON.stringify(checkout)});
      assert.equal(process.execPath, ${JSON.stringify(process.execPath)});
      assert.equal(process.env.BUN_INSTALL_CACHE_DIR, ${JSON.stringify(cache)});
      assert.equal(process.env.XDG_CONFIG_HOME, ${JSON.stringify(join(cache, "config"))});
      assert.equal(process.env.${secretKey}, undefined);
      assert.equal(process.env.LOTUS_UPDATE_TEST_DOTENV, undefined);
      assert.equal(process.env.GIT_TERMINAL_PROMPT, "0");
    `;
    await writeFile(join(checkout, "scripts", "bootstrap.ts"), `${checkEnv}
      assert.deepEqual(Bun.argv.slice(2), ["--build-only"]);
      const testProtocol = Bun.spawnSync([Bun.which("git"), "ls-remote", "ext::false"]);
      assert.notEqual(testProtocol.exitCode, 0);
      assert.match(testProtocol.stderr.toString(), /transport 'ext' not allowed/);
      await Bun.write("bootstrapped", "ready");
    `);
    await writeFile(join(checkout, "scripts", "check.ts"), `${checkEnv}
      assert.equal(await Bun.file("bootstrapped").text(), "ready");
      assert.equal(await Bun.file("plugins-prepared").text(), "ready");
      await Bun.write("checked", "done");
    `);

    await buildUpdateCheckout(checkout, cache, undefined, async () => {
      expect(await readFile(join(checkout, "bootstrapped"), "utf8")).toBe("ready");
      await writeFile(join(checkout, "plugins-prepared"), "ready");
    });
    expect(await readFile(join(checkout, "checked"), "utf8")).toBe("done");
    expect((await stat(cache)).mode & 0o077).toBe(0);
  } finally {
    if (previous === undefined) delete process.env[secretKey];
    else process.env[secretKey] = previous;
  }
}));

test("构建失败只返回阶段，初始化失败立即结束", () => fixture(async (_root, checkout, cache) => {
  await writeFile(join(checkout, "package.json"), JSON.stringify({ scripts: { typecheck: "bun scripts/check.ts" } }));
  await writeFile(join(checkout, "scripts", "bootstrap.ts"), `console.error("bootstrap secret fixture"); process.exit(9);`);
  await writeFile(join(checkout, "scripts", "check.ts"), `
    await Bun.write("checked", "attempted");
    console.error("typecheck secret fixture");
    process.exit(2);
  `);

  let prepared = false;
  await expect(buildUpdateCheckout(checkout, cache, undefined, async () => { prepared = true; }))
    .rejects.toThrow(/^更新候选初始化失败。$/u);
  expect(prepared).toBe(false);
  await expect(stat(join(checkout, "checked"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(checkout, "scripts", "bootstrap.ts"), "process.exit(0);");
  await expect(buildUpdateCheckout(checkout, cache)).rejects.toThrow(/^更新候选类型检查失败。$/u);
  expect(await readFile(join(checkout, "checked"), "utf8")).toBe("attempted");
}));

test("插件准备期间取消后不再启动类型检查", () => fixture(async (_root, checkout, cache) => {
  await writeFile(join(checkout, "package.json"), JSON.stringify({ scripts: { typecheck: "bun scripts/check.ts" } }));
  await writeFile(join(checkout, "scripts/bootstrap.ts"), "process.exit(0);");
  await writeFile(join(checkout, "scripts/check.ts"), 'await Bun.write("checked", "attempted");');
  const controller = new AbortController();
  await expect(buildUpdateCheckout(checkout, cache, controller.signal, async () => { controller.abort(); }))
    .rejects.toMatchObject({ name: "AbortError" });
  await expect(stat(join(checkout, "checked"))).rejects.toMatchObject({ code: "ENOENT" });
}));

test("第三方检出通过显式本地镜像初始化子模块，空清单跳过", () => fixture(async (root, checkout, cache) => {
  const git = Bun.which("git")!;
  async function run(cwd: string, ...args: string[]) {
    const child = Bun.spawn([git, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    expect(await child.exited).toBe(0);
  }
  await initializeUpdateSubmodules(checkout, cache);
  await expect(stat(cache)).rejects.toMatchObject({ code: "ENOENT" });

  const repository = join(root, "dependency");
  await mkdir(repository);
  await run(repository, "init", "--quiet", "-b", "main");
  await writeFile(join(repository, "marker"), "submodule");
  await run(repository, "add", "marker");
  await run(repository, "commit", "--quiet", "-m", "dependency");
  const mirror = join(root, "mirror.git");
  await run(root, "clone", "--quiet", "--bare", repository, mirror);
  await run(checkout, "init", "--quiet", "-b", "main");
  await run(checkout, "-c", "protocol.file.allow=always", "submodule", "add", pathToFileURL(mirror).href, "deps/example");
  await run(checkout, "commit", "--quiet", "-m", "candidate");
  const staged = join(root, "staged");
  await run(root, "clone", "--quiet", "--no-recurse-submodules", checkout, staged);
  await expect(stat(join(staged, "deps", "example", "marker"))).rejects.toMatchObject({ code: "ENOENT" });

  await initializeUpdateSubmodules(staged, cache);
  expect(await readFile(join(staged, "deps", "example", "marker"), "utf8")).toBe("submodule");
}));

function runBun(directory: string, cache: string, args: readonly string[]): string {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: directory, env: { PATH: process.env.PATH, BUN_INSTALL_CACHE_DIR: cache },
  });
  if (result.exitCode !== 0) throw new Error(`Bun 夹具命令失败。\n${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function makeLock(directory: string, cache: string) {
  runBun(directory, cache, ["install", "--offline", "--no-env-file", "--ignore-scripts", "--lockfile-only"]);
}

test.skipIf(!Bun.which("tar")).each(["bun.lock", "bun.lockb"] as const)(
  "外部插件按 %s 冻结重建，宿主工作区不变，切换目录后依赖仍可加载",
  (lock) => fixture(async (temporary) => {
    const host = join(temporary, "staged-host");
    const builtIn = join(host, "plugins/system");
    const plugin = join(host, "plugins/external");
    const source = join(temporary, "external-source");
    const vendor = join(temporary, "vendor/package");
    const cache = join(temporary, "staged-cache");
    const generatorCache = join(temporary, "generator-cache");
    await Promise.all([
      mkdir(builtIn, { recursive: true }), mkdir(source), mkdir(vendor, { recursive: true }),
    ]);
    const dependencies = { "@fixture/runtime": "file:./dependency.tgz" };
    const manifest = {
      name: "fixture-external", type: "module", dependencies, trustedDependencies: ["@fixture/runtime"],
    };
    const lifecycle = "fixture-lifecycle-output";
    await Promise.all([
      writeFile(join(host, "package.json"), JSON.stringify({ name: "fixture-host", private: true, workspaces: ["plugins/system"] })),
      writeFile(join(builtIn, "package.json"), '{"name":"fixture-system","version":"1.0.0"}'),
      writeFile(join(source, "package.json"), JSON.stringify(manifest)),
      writeFile(join(source, "entry.ts"), 'import value from "@fixture/runtime"; console.log(value);\n'),
      writeFile(join(vendor, "package.json"), JSON.stringify({
        name: "@fixture/runtime", version: "1.0.0", type: "module", exports: "./index.js",
        scripts: { postinstall: `bun -e 'await Bun.write(${JSON.stringify(lifecycle)}, "ran")'` },
      })),
      writeFile(join(vendor, "index.js"), 'export default "vendored fixture dependency";\n'),
    ]);
    const packed = Bun.spawnSync(["tar", "-czf", join(source, "dependency.tgz"), "-C", join(temporary, "vendor"), "package"]);
    expect(packed.exitCode).toBe(0);
    if (lock === "bun.lockb") await writeFile(join(source, "bunfig.toml"), "[install]\nsaveTextLockfile = false\n");
    makeLock(host, generatorCache);
    makeLock(source, generatorCache);
    const rootLock = await readFile(join(host, "bun.lock"));
    const pluginLock = await readFile(join(source, lock));
    // The binary lock is accepted without the setting that originally generated it.
    await rm(join(source, "bunfig.toml"), { force: true });
    await cp(source, plugin, { recursive: true });

    await buildExternalPluginCheckout(plugin, cache, true);
    await rm(join(plugin, "node_modules"), { recursive: true });
    await buildExternalPluginCheckout(plugin, cache, false);
    expect(await readFile(join(host, "bun.lock"))).toEqual(rootLock);
    expect(await readFile(join(plugin, lock))).toEqual(pluginLock);
    expect(await Bun.file(join(host, "node_modules/@fixture/runtime/index.js")).exists()).toBe(false);
    expect(await Bun.file(join(plugin, "node_modules/@fixture/runtime", lifecycle)).exists()).toBe(false);

    const manifestFile = join(plugin, "package.json");
    await cp(join(plugin, "dependency.tgz"), join(plugin, "different.tgz"));
    await writeFile(manifestFile, JSON.stringify({ ...manifest, dependencies: { "@fixture/runtime": "file:./different.tgz" } }));
    await expect(buildExternalPluginCheckout(plugin, cache, false)).rejects.toThrow("按外部插件的 Bun 锁文件安装");
    expect(await readFile(join(plugin, lock))).toEqual(pluginLock);
    await writeFile(manifestFile, JSON.stringify(manifest));

    const active = join(temporary, "active-host");
    await rename(host, active);
    await Promise.all([rm(cache, { recursive: true }), rm(source, { recursive: true })]);
    expect(runBun(join(active, "plugins/external"), join(temporary, "empty-cache"), ["run", "--no-install", "entry.ts"]))
      .toBe("vendored fixture dependency");
  }),
);

test("首次安装仅为运行时依赖要求 Bun 锁，旧版无锁外部插件继续使用现有路径", () => fixture(async (temporary) => {
  const plugin = join(temporary, "external");
  const cache = join(temporary, "cache");
  const manifest = join(plugin, "package.json");
  await mkdir(plugin);
  await buildExternalPluginCheckout(plugin, cache, true);
  await writeFile(manifest, JSON.stringify({ name: "fixture-dev-only", devDependencies: { "fixture-tool": "*" } }));
  await buildExternalPluginCheckout(plugin, cache, true);
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    await writeFile(manifest, JSON.stringify({ name: "fixture-runtime", [group]: { "fixture-library": "*" } }));
    await writeFile(join(plugin, "package-lock.json"), '{"name":"fixture-runtime","lockfileVersion":3}');
    await expect(buildExternalPluginCheckout(plugin, cache, true)).rejects.toThrow("须提供 bun.lock 或 bun.lockb");
    await buildExternalPluginCheckout(plugin, cache, false);
  }
  expect(await Bun.file(join(plugin, "bun.lock")).exists()).toBe(false);
  await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });
}));

test("冻结安装拒绝链接锁及链接清单", () => fixture(async (temporary) => {
  const plugin = join(temporary, "external");
  const cache = join(temporary, "cache");
  const external = join(temporary, "outside-file");
  const lock = join(plugin, "bun.lock");
  await mkdir(plugin);
  await writeFile(external, '{}');
  await symlink(external, lock);
  await expect(buildExternalPluginCheckout(plugin, cache, false)).rejects.toThrow("锁文件须为普通文件");
  await rm(lock);
  await writeFile(lock, '{}');
  await symlink(external, join(plugin, "package.json"));
  await expect(buildExternalPluginCheckout(plugin, cache, true)).rejects.toThrow("依赖清单须为普通文件");
  expect(await readFile(external, "utf8")).toBe("{}");
}));
