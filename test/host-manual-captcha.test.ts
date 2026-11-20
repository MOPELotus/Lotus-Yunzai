import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

test("人工验证页、状态和 OneBot 共用已配置监听，内部验证码接口仍不对外", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-manual-relay-host-"));
  const httpToken = "manual-http-fixture";
  const oneBotToken = "manual-onebot-fixture";
  const id = "a".repeat(32);
  let host: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    await mkdir(join(root, "vendor"));
    await symlink(fileURLToPath(new URL("../vendor/gt-manual/", import.meta.url)), join(root, "vendor", "gt-manual"), "dir");
    const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = reservation.port;
    const address = `http://127.0.0.1:${port}`;
    try {
      await writeFile(join(root, "config", "server.yaml"), `port: ${port}\nredirect: /panel\ncaptcha:\n  url: ${address}\n`);
    } finally {
      reservation.stop(true);
    }
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "ignore", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_TOKEN: httpToken, LOTUS_ONEBOT_TOKEN: oneBotToken },
    });
    const status = () => fetch(`${address}/status`, {
      headers: { Authorization: `Bearer ${httpToken}` }, signal: AbortSignal.timeout(1_000),
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (host.exitCode !== null) throw new Error(await new Response(host.stderr).text());
      const response = await status().catch(() => undefined);
      if (response?.ok) {
        await response.body?.cancel();
        break;
      }
      await response?.body?.cancel().catch(() => undefined);
      await Bun.sleep(25);
    }
    expect((await status()).status).toBe(200);
    expect((await fetch(`${address}/status`)).status).toBe(401);
    const base = `${address}/captcha/manual`;
    const unavailable = await fetch(`${base}/GTest/${id}`, { redirect: "manual" });
    expect(unavailable.status).toBe(410);
    expect(await unavailable.text()).toContain("验证链接已失效");
    const asset = await fetch(`${base}/verify.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Cache-Control")).toBe("no-store");
    expect(await asset.text()).toContain("initGeetest");
    expect((await fetch(`${base}/GTest/register`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/GTest/validate/${id}`)).status).toBe(404);
    expect((await fetch(`${address}/unknown`, { redirect: "manual" })).headers.get("Location")).toBe("/panel");

    const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    socket = new BunWebSocket(`ws://127.0.0.1:${port}/OneBotv11`, {
      headers: { Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
    });
    const ready = Promise.withResolvers<void>();
    socket.addEventListener("open", () => ready.resolve(), { once: true });
    socket.addEventListener("error", () => ready.reject(new Error("OneBot 共享端口未连通。")), { once: true });
    await ready.promise;
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    socket?.close();
    if (host && host.exitCode === null) host.kill("SIGTERM");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 8000);
