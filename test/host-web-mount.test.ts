import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

test.skipIf(process.platform === "win32")("面板端口挂载按扩展页票据调用私有 Unix 服务，停机不影响宿主", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-web-mount-"));
  const runtime = join(root, "runtime");
  const socket = join(runtime, "rpc.sock");
  const source = join(root, "upstream");
  const token = "panel-test-web-mount";
  try {
    await copyHost(root);
    await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(join(source, "guoba"), { recursive: true }), mkdir(join(root, "config"))]);
    await Promise.all([
      writeFile(join(root, "config", "server.yaml"), Bun.YAML.stringify({ port: 0, web_mount: { directory: source, socket } })),
      writeFile(join(source, "guoba", "index.js"), "throw new Error('原版动态入口只在 Node 上运行');"),
      writeFile(join(source, "guoba", "dashboard.html"), "<!doctype html><title>端口挂载</title>"),
      writeFile(join(source, "guoba", "dashboard.css"), "body { color: #111; }"),
      writeFile(join(source, "guoba", "dashboard.js"), "void 0;"),
    ]);
    const calls: unknown[] = [];
    let configured: unknown = { enabled: false };
    const privateService = Bun.serve({ unix: socket, async fetch(request) {
      const url = new URL(request.url);
      calls.push([request.method, url.pathname, url.search, request.headers.get("Authorization"), request.headers.get("guoba-access-token")]);
      if (request.method === "POST" && url.pathname === "/config") configured = await request.json();
      if (url.pathname === "/reload") return new Response(null, { status: 302, headers: { Location: "/config" } });
      return Response.json({ ok: true, result: configured });
    } });
    await chmod(socket, 0o600);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
      env: { PATH: process.env.PATH, LOTUS_PANEL_TOKEN: token, HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      let output = "";
      for await (const chunk of host.stdout) {
        output += Buffer.from(chunk).toString("utf8");
        if (output.includes("Lotus-Yunzai 已启动")) break;
      }
      const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
      expect(origin).toBeDefined();
      const fetchPanel = (path: string, init?: RequestInit) => fetch(new URL(path, origin), { signal: AbortSignal.timeout(2_000), ...init });
      const auth = { Authorization: `Bearer ${token}` };
      const list = await fetchPanel("/panel/api/extensions", { headers: auth });
      expect(await list.json()).toMatchObject({ issues: [], pages: [{ id: "web-mount", title: "端口挂载", servicePreview: true }] });
      const open = await fetchPanel("/panel/api/extensions/web-mount/open", { method: "POST", headers: auth });
      const page = new URL((await open.json()).url, origin);
      const frame = await fetch(page);
      const policy = frame.headers.get("Content-Security-Policy")!;
      expect(policy).toContain("frame-src 'self'");
      expect(policy).toContain("allow-popups-to-escape-sandbox");
      expect(policy).not.toContain("allow-same-origin");
      expect(await frame.text()).toContain("<title>端口挂载</title>");
      const endpoint = "/panel/extensions-api/web-mount";
      const ticket = { Origin: "null", "guoba-access-token": page.searchParams.get("token")! };
      expect((await fetchPanel(`${endpoint}/config`, { headers: { Origin: "null", ...auth } })).status).toBe(401);
      expect((await fetchPanel(`${endpoint}/config`, { headers: { ...ticket, Origin: "https://invalid.example" } })).status).toBe(403);
      expect((await fetchPanel(`${endpoint}/admin`, { headers: ticket })).status).toBe(404);
      expect(calls).toEqual([]);
      expect((await fetchPanel(`${endpoint}/config?spoof=1`, {
        method: "POST", headers: { ...ticket, ...auth, "Content-Type": "application/json" }, body: '{"enabled":true}',
      })).status).toBe(200);
      const saved = await fetchPanel(`${endpoint}/config`, { headers: ticket });
      expect(await saved.json()).toEqual({ ok: true, result: { enabled: true } });
      expect((await fetchPanel(`${endpoint}/reload`, { method: "POST", headers: ticket })).status).toBe(503);
      expect(calls).toEqual([
        ["POST", "/config", "", null, null], ["GET", "/config", "", null, null], ["POST", "/reload", "", null, null],
      ]);
      await chmod(runtime, 0o755);
      expect((await fetchPanel(`${endpoint}/data`, { headers: ticket })).status).toBe(503);
      expect(calls).toHaveLength(3);
      await privateService.stop(true);
      expect((await fetchPanel(`${endpoint}/data`, { headers: ticket })).status).toBe(503);
      expect((await fetchPanel("/status")).status).toBe(200);
    } finally {
      host.kill();
      await host.exited;
      await privateService.stop(true);
    }
    expect(await stderr).not.toContain("动态入口只在 Node 上运行");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
