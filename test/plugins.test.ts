import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("宿主导入正常模块，并在执行入口前拒载旧包、鸣潮插件和重复插件", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-plugins-"));
  const installed = join(root, "plugins");

  async function install(directory: string, name: string, options: object, allowed = false) {
    const path = join(installed, directory);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({
      name,
      lotusYunzai: { entry: "./index.ts" },
      ...options,
    }));
    await writeFile(join(path, "index.ts"), allowed
      ? 'export default { commands: { "#问候": (name: string) => "你好，" + name } };'
      : 'console.log("拒载入口已执行");');
    return path;
  }

  try {
    await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
    await cp(new URL("../app.ts", import.meta.url), join(root, "app.ts"));
    await install("a-hello", "hello", { repository: "https://github.com/example/hello.git" }, true);
    await install("b-duplicate", "hello-fork", { repository: "https://gitee.com/example/hello" });
    const renamed = await install("c-renamed", "locally-renamed", {});
    const git = Bun.which("git")!;
    for (const args of [
      ["init", "--quiet"],
      ["remote", "add", "origin", "git@gitee.com:mirror/miao-plugin.git"],
    ]) {
      expect(await Bun.spawn([git, ...args], { cwd: renamed }).exited).toBe(0);
    }
    await install("d-mixed", "mixed-games", {
      lotusYunzai: { entry: "./index.ts", games: ["genshin", "Wuthering-Waves"] },
    });
    await install("e-legacy", "@example/yenai-plugin", {});
    await install("f-escape", "escaped-entry", { lotusYunzai: { entry: "../a-hello/index.ts" } });

    await install("g-host", "host", {});

    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdin: new Blob(["#问候 Lotus\n#状态\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited,
    ]);
    expect(exit).toBe(0);
    expect(stdout).toContain("你好，Lotus");
    expect(stdout).toContain("Lotus-Yunzai 正在运行");
    expect(stdout).not.toContain("拒载入口已执行");
    expect(stderr).toContain("拒绝加载 b-duplicate：与 a-hello 重复");
    expect(stderr).toContain("拒绝加载 c-renamed");
    expect(stderr).toContain("拒绝加载 d-mixed（mixed-games）：包含鸣潮功能");
    expect(stderr).toContain("拒绝加载 e-legacy");
    expect(stderr).toContain("拒绝加载 f-escape");
    expect(stderr).toContain("拒绝加载 g-host：模块 host 已注册");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
