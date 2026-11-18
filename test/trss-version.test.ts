import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const version = "0.4.0-beta.2";
const httpToken = "version-http-fixture";
const panelToken = "version-panel-fixture";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", ...args,
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.exitCode !== 0) throw new Error(`Git 夹具命令失败（${args[0]}）。\n${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function withHost(root: string, run: (host: {
  statusUrl: URL;
  versionOutput(lastLine: RegExp): Promise<string>;
}) => Promise<void>) {
  const host = Bun.spawn([process.execPath, "app.ts"], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_HTTP_TOKEN: httpToken, LOTUS_PANEL_TOKEN: panelToken,
    },
  });
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  const stderr = new Response(host.stderr).text();
  const timer = setTimeout(() => host.kill("SIGKILL"), 4_000);
  let output = "";
  async function readUntil(pattern: RegExp) {
    while (true) {
      const match = pattern.exec(output);
      if (match) return match;
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`版本测试宿主未输出 ${pattern.source}。\n${output}\n${await stderr}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
  }

  try {
    const endpoint = await readUntil(/http:\/\/127\.0\.0\.1:\d+\/status/u);
    await run({
      statusUrl: new URL(endpoint[0]),
      async versionOutput(lastLine) {
        host.stdin.write("#版本\n");
        host.stdin.flush();
        await readUntil(lastLine);
        return output.slice(output.lastIndexOf("Lotus-Yunzai 版本\n"));
      },
    });
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill();
    await host.exited;
    clearTimeout(timer);
    host.stdin.end();
    reader.releaseLock();
  }
}

function statusRequest(url: URL, token?: string) {
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(2_000),
  });
}

test("终端版本和独立鉴权的运行状态报告真实 Git 提交与包版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-version-"));
  try {
    await copyHost(root);
    await Promise.all([
      writeFile(join(root, "package.json"), JSON.stringify({ name: "lotus-yunzai", type: "module", version })),
      writeFile(join(root, ".gitignore"), "/node_modules\n"),
    ]);
    const system = join(root, "plugins", "system");
    git(system, "init", "--quiet");
    git(system, "add", "package.json", "index.ts");
    git(system, "commit", "--quiet", "-m", "Fixture system module");
    const moduleRevision = git(system, "rev-parse", "HEAD");

    git(root, "init", "--quiet");
    git(root, "config", "-f", ".gitmodules", "submodule.plugins/system.path", "plugins/system");
    git(root, "config", "-f", ".gitmodules", "submodule.plugins/system.url", "./plugins/system");
    git(root, "add", "app.ts", "lib", "package.json", ".gitignore", ".gitmodules");
    git(root, "update-index", "--add", "--cacheinfo", `160000,${moduleRevision},plugins/system`);
    git(root, "commit", "--quiet", "-m", "Fixture host version");
    const revision = git(root, "rev-parse", "HEAD");

    await withHost(root, async ({ statusUrl, versionOutput }) => {
      const report = await versionOutput(/^system　[a-f0-9]{12}\n/mu);
      expect(report).toContain(`宿主版本　${version}\n`);
      expect(report).toContain(`宿主提交　${revision.slice(0, 12)}\n`);
      expect(report).toContain(`内置模块\nsystem　${moduleRevision.slice(0, 12)}\n`);

      for (const [path, token, other] of [
        ["/status", httpToken, panelToken], ["/panel/api/status", panelToken, httpToken],
      ] as const) {
        const url = new URL(path, statusUrl);
        expect((await statusRequest(url)).status).toBe(401);
        expect((await statusRequest(url, other)).status).toBe(401);
        const response = await statusRequest(url, token);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "ok", name: "Lotus-Yunzai", version, revision });
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("无包清单和 Git 元数据的宿主仍能启动并报告开发构建", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-development-version-"));
  try {
    await copyHost(root);
    await withHost(root, async ({ statusUrl, versionOutput }) => {
      const report = await versionOutput(/^暂无内置模块版本记录\n/mu);
      expect(report).toContain("宿主版本　开发构建\n");
      expect(report).toContain("宿主提交　提交号不可用\n");
      const response = await statusRequest(statusUrl, httpToken);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", name: "Lotus-Yunzai" });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
