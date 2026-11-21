import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

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
