import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

test("普通初始化仍构建面板，显式 V3 自测才需要 Shotium", async () => {
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
    await Promise.all(["scripts/bootstrap.ts", "lib/renderer/shotium.ts"].map(async file => {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await cp(new URL(`../${file}`, import.meta.url), join(root, file));
    }));
    expect((await run(["install", "--lockfile-only"]))[0]).toBe(0);
    expect((await run(["scripts/bootstrap.ts"]))[0]).toBe(0);
    expect(await panelMarker.text()).toBe("ok");
    await panelMarker.delete();

    const [code, errors] = await run(["scripts/bootstrap.ts", "--verify-v3-renderer"]);
    expect(code).toBe(1);
    expect(errors).toContain("Shotium 原生库加载失败");
    expect(await panelMarker.exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("缺依赖时日常入口提示 bootstrap 且不访问包注册表", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-boot-deps-"));
  const requests: string[] = [];
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response(null, { status: 404 });
  } });
  try {
    for (const name of ["bunfig.toml", "bun.lock", "package.json", "scripts", "lib"]) {
      await cp(new URL(`../${name}`, import.meta.url), join(root, name), { recursive: true });
    }
    await mkdir(join(root, "plugins", "atlas"), { recursive: true });
    await cp(new URL("../plugins/atlas/initialize-atlas.ts", import.meta.url), join(root, "plugins", "atlas", "initialize-atlas.ts"));
    await writeFile(join(root, ".npmrc"), `registry=http://127.0.0.1:${registry.port}/\n`);
    for (const args of [["init", "live"], ["start"]]) {
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
