import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildUpdateCheckout, initializeUpdateSubmodules } from "../lib/update-build.ts";

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
      const testProtocol = Bun.spawnSync([Bun.which("git"), "ls-remote", "ext::false"]);
      assert.notEqual(testProtocol.exitCode, 0);
      assert.match(testProtocol.stderr.toString(), /transport 'ext' not allowed/);
      await Bun.write("bootstrapped", "ready");
    `);
    await writeFile(join(checkout, "scripts", "check.ts"), `${checkEnv}
      assert.equal(await Bun.file("bootstrapped").text(), "ready");
      await Bun.write("checked", "done");
    `);

    await buildUpdateCheckout(checkout, cache);
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

  await expect(buildUpdateCheckout(checkout, cache)).rejects.toThrow(/^更新候选初始化失败。$/u);
  await expect(stat(join(checkout, "checked"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(checkout, "scripts", "bootstrap.ts"), "process.exit(0);");
  await expect(buildUpdateCheckout(checkout, cache)).rejects.toThrow(/^更新候选类型检查失败。$/u);
  expect(await readFile(join(checkout, "checked"), "utf8")).toBe("attempted");
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
