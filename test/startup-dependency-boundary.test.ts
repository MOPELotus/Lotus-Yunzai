import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

test("一次初始化完成面板和运行资料，构建候选不改运行资料，显式 V3 自测才需要 Shotium", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-boot-without-shotium-"));
  const environment = {
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    HOME: root, BUN_INSTALL_CACHE_DIR: join(root, "empty-cache"),
  };
  function run(args: string[]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
      cwd: root, env: environment, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    return Promise.all([child.exited, new Response(child.stderr).text()]);
  }
  const panelMarker = Bun.file(join(root, "panel-built"));
  try {
    await Bun.write(join(root, "package.json"), JSON.stringify({
      packageManager: `bun@${Bun.version}`, scripts: { "build:panel": "bun build-panel.ts" },
    }));
    await Bun.write(join(root, "build-panel.ts"), 'await Bun.write("panel-built", "ok");');
    await Bun.write(join(root, "packages/skia/index.ts"), "export {};");
    await Promise.all(["packages/i18n/index.ts", "i18n/zh-CN.json", "lib/i18n-preload.ts", "scripts/bootstrap.ts", "lib/initialization-state.ts", "scripts/verify-builtin-resources.ts", "lib/builtin-resource-validation.ts", "lib/resource-progress.ts", "lib/renderer/shotium.ts", "lib/initialization-progress.ts", "lib/terminal-log-format.ts", "lib/terminal-output.ts", "lib/runtime-logs.ts", "lib/shanghai-date.ts"].map(async file => {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await cp(new URL(`../${file}`, import.meta.url), join(root, file));
    }));
    await Bun.write(join(root, "resources/builtin/test.txt"), "asset");
    await Bun.write(join(root, "resources/builtin/manifest.json"), JSON.stringify({ format: 1, files: [{
      path: "resources/builtin/test.txt", bytes: 5, sha256: new Bun.CryptoHasher("sha256").update("asset").digest("hex"),
    }] }));
    await Bun.write(join(root, "scripts/launcher.ts"), `
      if (Bun.argv[2] !== "init") throw Error("必须通过统一初始化入口");
      const child = Bun.spawn([process.execPath, "scripts/startup.ts", "--initialize", ...Bun.argv.slice(3)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exitCode = await child.exited;
    `);
    await Bun.write(join(root, "scripts/startup.ts"), `
      if (!await Bun.file("panel-built").exists()) throw Error("运行资料必须在安装和面板构建后准备");
      if (Bun.argv[2] !== "--initialize") throw Error("必须完成首次初始化");
      await Bun.write("initialized", JSON.stringify(Bun.argv.slice(2)));
      if (await Bun.file("fail-runtime").exists()) process.exit(9);
    `);
    expect((await run(["install", "--lockfile-only"]))[0]).toBe(0);
    expect((await run(["scripts/bootstrap.ts"]))[0]).toBe(0);
    expect(await panelMarker.text()).toBe("ok");
    const initialized = Bun.file(join(root, "initialized"));
    expect(await initialized.json()).toEqual(["--initialize"]);
    expect((await run(["scripts/bootstrap.ts", "live"]))[0]).toBe(0);
    expect(await initialized.json()).toEqual(["--initialize", "live"]);
    await initialized.delete();
    expect((await run(["scripts/bootstrap.ts", "--build-only"]))[0]).toBe(0);
    expect(await initialized.exists()).toBe(false);
    await panelMarker.delete();
    const [invalidCode] = await run(["scripts/bootstrap.ts", "invalid-channel"]);
    expect(invalidCode).toBe(1);
    expect(await panelMarker.exists()).toBe(false);
    await Bun.write(join(root, "fail-runtime"), "fixture");
    const [failedCode, failedMessage] = await run(["scripts/bootstrap.ts"]);
    expect(failedCode).toBe(9);
    expect(failedMessage).toContain("运行资料未准备完成");
    expect(failedMessage).toContain("bun run bootstrap");
    await panelMarker.delete();

    const [code, errors] = await run(["scripts/bootstrap.ts", "--verify-v3-renderer"]);
    expect(code).toBe(1);
    expect(errors).toContain("Shotium 原生库加载失败");
    expect(await panelMarker.exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("缺依赖时启动提示 bootstrap 且不访问包注册表", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-boot-deps-"));
  const requests: string[] = [];
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response(null, { status: 404 });
  } });
  try {
    for (const name of ["bunfig.toml", "bun.lock", "package.json", "scripts", "lib", "i18n", "packages/i18n"]) {
      await cp(new URL(`../${name}`, import.meta.url), join(root, name), { recursive: true });
    }
    await mkdir(join(root, "plugins", "atlas"), { recursive: true });
    await cp(new URL("../plugins/atlas/initialize-atlas.ts", import.meta.url), join(root, "plugins", "atlas", "initialize-atlas.ts"));
    await writeFile(join(root, ".npmrc"), `registry=http://127.0.0.1:${registry.port}/\n`);
    for (const args of [["start"]]) {
      const child = Bun.spawn([process.execPath, "run", ...args], { cwd: root,
        env: {
          PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
          HOME: root, BUN_INSTALL_CACHE_DIR: join(root, "empty-cache"),
        },
        stdin: "ignore", stdout: "ignore", stderr: "pipe",
      });
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(errors).toContain("启动依赖尚未就绪。请先运行 bun run bootstrap。");
    }
    expect(requests).toEqual([]);
  } finally {
    registry.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
