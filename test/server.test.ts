import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

test("公共 HTTP 和反向 OneBot 可分别监听并独立鉴权", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-server-"));
  try {
    await copyHost(root);

    const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const wsPort = reservation.port;
    reservation.stop(true);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        LOTUS_HTTP_PORT: "0",
        LOTUS_ONEBOT_PORT: String(wsPort),
        LOTUS_HTTP_TOKEN: "http-fixture",
        LOTUS_ONEBOT_TOKEN: "onebot-fixture",
      },
    });
    const reader = host.stdout.getReader();
    const timeout = setTimeout(() => host.kill("SIGKILL"), 4_000);
    try {
      const decoder = new TextDecoder();
      let text = "";
      let statusUrl: string | undefined;
      while (!statusUrl) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`HTTP 未启动：${await new Response(host.stderr).text()}`);
        text += decoder.decode(chunk.value, { stream: true });
        statusUrl = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(text)?.[0];
      }
      expect(text).toContain(`ws://127.0.0.1:${wsPort}/OneBotv11`);
      expect(Number(new URL(statusUrl).port)).not.toBe(wsPort);

      const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
      const wsUrl = `http://127.0.0.1:${wsPort}/OneBotv11`;
      expect((await fetch(statusUrl, { headers: auth("onebot-fixture") })).status).toBe(401);
      expect((await fetch(statusUrl, { headers: auth("http-fixture") })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${wsPort}/status`)).status).toBe(404);
      expect((await fetch(new URL("/OneBotv11", statusUrl))).status).toBe(404);
      expect((await fetch(wsUrl, { headers: auth("http-fixture") })).status).toBe(401);
      expect((await fetch(wsUrl, {
        headers: { ...auth("onebot-fixture"), "X-Client-Role": "Universal" },
      })).status).toBe(426);
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
      if (host.exitCode === null) host.kill();
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
