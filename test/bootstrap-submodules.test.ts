import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

test("普通clone后一次bootstrap补拉缺失子模块并锁定主仓指定提交，再完成运行初始化", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-bootstrap-submodules-"));
  const source = join(temporary, "source"), dependency = join(temporary, "dependency"), checkout = join(temporary, "checkout");
  const env = { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    BUN_INSTALL_CACHE_DIR: join(temporary, "cache") };
  async function git(cwd: string, ...args: string[]) {
    const child = Bun.spawn(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd, env, stdout: "pipe", stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw Error(error);
    return output.trim();
  }
  try {
    await mkdir(source); await mkdir(dependency);
    await git(dependency, "init", "--quiet", "-b", "main");
    await writeFile(join(dependency, "version.txt"), "locked-version");
    await git(dependency, "add", "."); await git(dependency, "commit", "--quiet", "-m", "locked");
    const locked = await git(dependency, "rev-parse", "HEAD");
    await git(source, "init", "--quiet", "-b", "main");
    await mkdir(join(source, "scripts")); await mkdir(join(source, "packages/skia"), { recursive: true });
    await cp(new URL("../scripts/bootstrap.ts", import.meta.url), join(source, "scripts/bootstrap.ts"));
    await mkdir(join(source, "lib"));
    for (const name of ["initialization-progress", "terminal-log-format", "terminal-output", "runtime-logs", "shanghai-date"])
      await cp(new URL(`../lib/${name}.ts`, import.meta.url), join(source, `lib/${name}.ts`));
    await writeFile(join(source, "packages/skia/index.ts"), "export {};");
    await writeFile(join(source, "package.json"), JSON.stringify({ packageManager: `bun@${Bun.version}`,
      scripts: { "build:panel": "bun build-panel.ts" } }));
    await writeFile(join(source, "build-panel.ts"), 'await Bun.write("panel-built", "ready");');
    await writeFile(join(source, "scripts/launcher.ts"), `
      if (Bun.argv[2] !== "init") throw Error("必须通过统一初始化入口");
      const child = Bun.spawn([process.execPath, "scripts/startup.ts", "--initialize", ...Bun.argv.slice(3)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exitCode = await child.exited;
    `);
    await writeFile(join(source, "scripts/startup.ts"), `
      if (await Bun.file("plugins/fixture/version.txt").text() !== "locked-version") throw Error("子模块版本不正确");
      if (!await Bun.file("panel-built").exists()) throw Error("面板尚未构建");
      if (Bun.argv[2] !== "--initialize") throw Error("未执行完整初始化");
      await Bun.write("runtime-ready", "ready");
    `);
    const lock = Bun.spawn([process.execPath, "install", "--lockfile-only"], { cwd: source, env, stdout: "ignore", stderr: "pipe" });
    expect(await lock.exited).toBe(0);
    await git(source, "submodule", "add", "--quiet", dependency, "plugins/fixture");
    await git(source, "add", "."); await git(source, "commit", "--quiet", "-m", "host");
    // Upstream advanced after the host pinned its dependency; init must not chase it.
    await writeFile(join(dependency, "version.txt"), "newer-upstream-version");
    await git(dependency, "add", "."); await git(dependency, "commit", "--quiet", "-m", "newer");
    await git(temporary, "clone", "--quiet", "--no-recurse-submodules", source, checkout);
    expect(await Bun.file(join(checkout, "plugins/fixture/version.txt")).exists()).toBe(false);
    const initialize = Bun.spawn([process.execPath, "scripts/bootstrap.ts"], {
      cwd: checkout, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([initialize.exited, new Response(initialize.stdout).text(), new Response(initialize.stderr).text()]);
    if (code !== 0) throw Error(output + error);
    expect(await readFile(join(checkout, "runtime-ready"), "utf8")).toBe("ready");
    expect(await git(join(checkout, "plugins/fixture"), "rev-parse", "HEAD")).toBe(locked);
    expect(await git(checkout, "submodule", "status", "--recursive")).not.toMatch(/^[-+U]/mu);
    expect(output).toContain("全部准备完成");
    expect(error).toContain("同步 Git 子模块");
    expect(error).toContain("安装锁定依赖完成");
    expect(error).toContain("构建管理面板完成");
    expect(error).toContain("准备运行资料完成");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 20_000);
