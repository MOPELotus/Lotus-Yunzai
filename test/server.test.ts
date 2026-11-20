import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOneBot } from "../lib/adapters/onebot.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";
import { copyHost } from "./host-fixture.ts";

test("公共 HTTP 和反向 OneBot 可分别监听并独立鉴权", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-server-"));
  try {
    await copyHost(root);
    const broken = join(root, "plugins", "fixture-broken.js");
    await writeFile(broken, 'throw new Error("fixture-private-value");');
    const old = join(root, "plugins", "xhh-tl");
    await mkdir(old);
    await writeFile(join(old, "package.json"), '{"name":"xhh-tl","lotusYunzai":{"games":["wuwa"]}}');
    await writeFile(join(old, "index.js"), 'throw new Error("拒载入口不应执行");');
    const original = join(root, "plugins", "xhh");
    await mkdir(original);
    await writeFile(join(original, "index.js"), 'throw new Error("拒载入口不应执行");');
    await writeFile(join(old, "guoba.support.js"), 'throw new Error("不能从拒载插件导入配置");');
    const compatible = join(root, "plugins", "compatible");
    await mkdir(compatible);
    await writeFile(join(compatible, "index.js"), "export default class extends plugin {}");
    await writeFile(join(compatible, "guoba.support.js"), `
      let enabled = false;
      export function supportGuoba() {
        return { configInfo: {
          schemas: [
            { field: "enabled", label: "启用", component: "Switch" },
            { field: "secret", label: "令牌", component: "InputPassword" },
          ],
          getConfigData: () => ({ enabled, secret: "fixture-hidden" }),
          setConfigData(data, { Result }) {
            if (data.secret !== "fixture-hidden") return Result.error("未保留秘密");
            enabled = data.enabled;
            return Result.ok({ private: data.secret });
          },
        } };
      }
    `);
    const pages = join(compatible, "guoba");
    await mkdir(pages);
    await writeFile(join(pages, "page.json"), JSON.stringify({
      id: "dashboard", title: "示例扩展", html: "<h1>扩展页</h1>", script: "dashboard.js",
    }));
    await writeFile(join(pages, "dashboard.js"), 'document.body.dataset.loaded = "true";');
    await writeFile(join(pages, "hidden.js"), 'throw new Error("未声明");');
    const dynamic = join(root, "plugins", "dynamic");
    await mkdir(join(dynamic, "webadapter"), { recursive: true });
    await writeFile(join(dynamic, "index.js"), "export default class extends plugin {}");
    await writeFile(join(dynamic, "webadapter", "index.js"), `
      export function init(ctx) {
        ctx.registerPage({ id: "api-demo", title: "带接口的扩展", src: "view.html" });
        ctx.registerApi("get", "/reports/:id", (req, res) => {
          res.json({ id: req.params.id, range: req.query.range });
        });
        ctx.registerApi("put", "/reports/:id", (req, res) => {
          res.status(201).json({ id: req.params.id, saved: req.body });
        });
      }
    `);
    await writeFile(join(dynamic, "webadapter", "view.html"), '<!doctype html><html><head><title>报告</title></head><body>报告</body></html>');

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
        LOTUS_PANEL_TOKEN: "panel-fixture",
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
      const panelUrl = new URL("/panel/api/plugins", statusUrl);
      const panelStatus = new URL("/panel/api/status", statusUrl);
      expect((await fetch(panelUrl)).status).toBe(401);
      expect((await fetch(panelUrl, { headers: auth("http-fixture") })).status).toBe(401);
      expect((await fetch(panelUrl, { headers: auth("onebot-fixture") })).status).toBe(401);
      expect((await fetch(statusUrl, { headers: auth("panel-fixture") })).status).toBe(401);
      const report = await fetch(panelUrl, { headers: auth("panel-fixture") });
      expect(report.headers.get("Cache-Control")).toBe("no-store");
      expect(await report.json()).toMatchObject({ plugins: expect.arrayContaining([
        { name: "system", status: "loaded" },
        { name: "fixture-broken.js", status: "failed", reason: "入口加载或初始化失败，请查看宿主日志。" },
        { name: "xhh-tl", status: "rejected", reason: "旧插件功能已归并，请使用 公共账号服务和游戏模块。" },
        { name: "xhh", status: "rejected", reason: expect.stringContaining("media") },
      ]) });
      expect(await (await fetch(panelStatus, { headers: auth("panel-fixture") })).json())
        .toMatchObject({ status: "ok", name: "Lotus-Yunzai" });
      expect((await fetch(panelUrl, { headers: auth("panel-fixture"), method: "POST" })).status).toBe(405);
      const head = await fetch(panelUrl, { headers: auth("panel-fixture"), method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect((await fetch(`http://127.0.0.1:${wsPort}${panelUrl.pathname}`, { headers: auth("panel-fixture") })).status)
        .toBe(404);
      const home = new URL("/panel/", statusUrl);
      expect((await fetch(home)).status).toBe(503);
      const dist = join(root, "panel", "dist");
      await mkdir(join(dist, "assets"), { recursive: true });
      await writeFile(join(dist, "index.html"), '<html lang="zh-CN"><title>Lotus-Yunzai 管理面板</title></html>');
      await writeFile(join(dist, "assets", "main-fixture.js"), 'console.log("panel");');
      await symlink(broken, join(dist, "assets", "outside.js"));
      const redirect = await fetch(new URL("/panel", statusUrl), { redirect: "manual" });
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get("Location")).toBe("/panel/");
      const page = await fetch(home);
      expect(page.status).toBe(200);
      expect(page.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
      expect(page.headers.get("Cache-Control")).toBe("no-store");
      expect(await page.text()).toContain("Lotus-Yunzai 管理面板");
      const script = new URL("assets/main-fixture.js", home);
      expect(await (await fetch(script)).text()).toContain('console.log("panel")');
      expect(await (await fetch(script, { method: "HEAD" })).text()).toBe("");
      expect((await fetch(new URL("assets/outside.js", home))).status).toBe(404);
      expect((await fetch(new URL("/panel/api/missing", statusUrl))).status).toBe(404);
      const guoba = new URL("/panel/api/guoba", statusUrl);
      const form = new URL("/panel/api/guoba/compatible", statusUrl);
      expect((await fetch(form)).status).toBe(401);
      expect(await (await fetch(guoba, { headers: auth("panel-fixture") })).json()).toEqual({ plugins: ["compatible"] });
      expect((await fetch(new URL("/panel/api/guoba/xhh-tl", statusUrl), { headers: auth("panel-fixture") })).status).toBe(404);
      const beforeForm = await (await fetch(form, { headers: auth("panel-fixture") })).json();
      expect(beforeForm).toMatchObject({ values: { enabled: false }, configuredPasswords: ["secret"] });
      expect(JSON.stringify(beforeForm)).not.toContain("fixture-hidden");
      const savedForm = await fetch(form, {
        method: "PUT", headers: { ...auth("panel-fixture"), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(savedForm.status).toBe(200);
      expect(await savedForm.text()).not.toContain("fixture-hidden");
      expect(await (await fetch(form, { headers: auth("panel-fixture") })).json()).toMatchObject({ values: { enabled: true } });

      const extensionList = new URL("/panel/api/extensions", statusUrl);
      expect((await fetch(extensionList)).status).toBe(401);
      expect(await (await fetch(extensionList, { headers: auth("panel-fixture") })).json()).toEqual({
        pages: [
          { id: "dashboard", plugin: "compatible", title: "示例扩展", priority: 100 },
          { id: "api-demo", plugin: "dynamic", title: "带接口的扩展", priority: 100 },
        ], issues: [],
      });
      const open = new URL("/panel/api/extensions/dashboard/open", statusUrl);
      expect((await fetch(open, { method: "POST" })).status).toBe(401);
      const ticket = await (await fetch(open, { method: "POST", headers: auth("panel-fixture") })).json() as { url: string };
      const frame = new URL(ticket.url, statusUrl);
      expect(frame.search).toBe("");
      const contents = await fetch(frame);
      expect(contents.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
      expect(contents.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(await contents.text()).toContain("<h1>扩展页</h1>");
      expect(await (await fetch(new URL("dashboard.js", frame))).text()).toContain("dataset.loaded");
      expect((await fetch(new URL("hidden.js", frame))).status).toBe(404);
      expect((await fetch(new URL(frame.pathname.replace("/dashboard/", "/other/"), frame))).status).toBe(404);

      const dynamicOpen = new URL("/panel/api/extensions/api-demo/open", statusUrl);
      const dynamicTicket = await (await fetch(dynamicOpen, { method: "POST", headers: auth("panel-fixture") })).json() as { url: string };
      const dynamicFrame = new URL(dynamicTicket.url, statusUrl);
      const access = dynamicFrame.searchParams.get("token")!;
      expect(access).not.toBe("panel-fixture");
      const dynamicPage = await fetch(dynamicFrame);
      expect(dynamicPage.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
      const source = await dynamicPage.text();
      const bridge = /<script src="([^"]+)"/u.exec(source)?.[1];
      expect(bridge).toBeDefined();
      expect(await (await fetch(new URL(bridge!, statusUrl))).text()).toContain("window.__GUOBA__");

      const reportPath = `${dynamicFrame.searchParams.get("__apiBase")}/reports/weekly?range=7`;
      const selectedReport = new URL(reportPath, statusUrl);
      expect((await fetch(selectedReport, { headers: { "guoba-access-token": access } })).status).toBe(403);
      expect((await fetch(selectedReport, { headers: { Origin: "null" } })).status).toBe(401);
      const assetTicket = dynamicFrame.pathname.split("/")[4]!;
      expect((await fetch(selectedReport, { headers: { Origin: "null", "guoba-access-token": assetTicket } })).status)
        .toBe(401);
      expect((await fetch(new URL(reportPath.replace("/api-demo/", "/dashboard/"), statusUrl), {
        headers: { Origin: "null", "guoba-access-token": access },
      })).status).toBe(401);
      const allowed = await fetch(selectedReport, { headers: { Origin: "null", "guoba-access-token": access } });
      expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("null");
      expect(await allowed.json()).toEqual({ id: "weekly", range: "7" });
      const preflight = {
        Origin: "null", "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type, guoba-access-token",
      };
      expect((await fetch(selectedReport, { method: "OPTIONS", headers: preflight })).status).toBe(204);
      expect((await fetch(selectedReport, {
        method: "OPTIONS", headers: { ...preflight, "Access-Control-Request-Headers": "authorization" },
      })).status).toBe(403);
      const saved = await fetch(selectedReport, {
        method: "PUT", headers: { Origin: "null", "guoba-access-token": access, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, count: 0 }),
      });
      expect(saved.status).toBe(201);
      expect(await saved.json()).toEqual({ id: "weekly", saved: { enabled: false, count: 0 } });
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

test("群发送按在线 OneBot 账号派发，回执区分未发送与连接中断", async () => {
  const groups = new OneBotGroups();
  const messageSeen = Promise.withResolvers<void>();
  const server = startOneBot(async () => messageSeen.resolve(), {
    hostname: "127.0.0.1", port: 0, isMaster: () => false, masterIds: () => [], groups,
    auth: new Headers({ Authorization: "Bearer group-test" }),
  });
  const url = new URL("/OneBotv11", server.url);
  url.protocol = "ws:";
  const sockets: WebSocket[] = [];

  async function connect(botId?: number) {
    const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const headers: Record<string, string> = { Authorization: "Bearer group-test", "X-Client-Role": "Universal" };
    if (botId !== undefined) headers["X-Self-ID"] = String(botId);
    const socket = new BunWebSocket(url.href, { headers });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return socket;
  }

  function nextFrame(socket: WebSocket): Promise<{ action: string; params: unknown; echo: string }> {
    return new Promise((resolve) => {
      socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
    });
  }

  function confirm(socket: WebSocket, echo: string, data?: unknown) {
    socket.send(JSON.stringify({ echo, status: "ok", retcode: 0, data }));
  }

  try {
    const first = await connect(99);
    const second = await connect();
    second.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect", self_id: 100 }));
    second.send(JSON.stringify({ post_type: "message", message_type: "private", self_id: 100, user_id: 42, message: "好" }));
    await messageSeen.promise;
    expect(groups.onlineBots()).toEqual([99, 100]);

    const firstFrame = nextFrame(first);
    const list = groups.listGroups(99);
    const listRequest = await firstFrame;
    expect(listRequest).toMatchObject({ action: "get_group_list", params: {} });
    confirm(first, listRequest.echo, [{ group_id: 77, group_name: "图鉴群" }]);
    expect(await list).toEqual([{ id: 77, name: "图鉴群" }]);

    const nextSecond = nextFrame(second);
    const sent = groups.sendGroup(100, 77, [{ type: "text", text: "测试" }, { type: "at", qq: 42 }]);
    const sendRequest = await nextSecond;
    expect(sendRequest).toMatchObject({ action: "send_msg", params: { message_type: "group", group_id: 77, message: [
      { type: "text", data: { text: "测试" } }, { type: "at", data: { qq: "42" } },
    ] } });
    confirm(first, sendRequest.echo, { message_id: 0 });
    confirm(second, sendRequest.echo, { message_id: -275 });
    expect(await sent).toBe(-275);

    const replacement = await connect(99);
    first.close();
    const nextReplacement = nextFrame(replacement);
    const deletion = groups.deleteMessage(99, -275);
    const deleteRequest = await nextReplacement;
    expect(deleteRequest).toMatchObject({ action: "delete_msg", params: { message_id: -275 } });
    confirm(replacement, deleteRequest.echo);
    await deletion;

    const lastFrame = nextFrame(second);
    const interrupted = groups.sendGroup(100, 77, "测试断线").then(() => undefined, (error) => error);
    await lastFrame;
    second.close();
    const error = await interrupted;
    expect(error).toBeInstanceOf(Error);
    expect(error.delivery).toBeUndefined();
    expect(groups.onlineBots()).toEqual([99]);
    await expect(groups.sendGroup(100, 77, "重试")).rejects.toMatchObject({ delivery: "not-sent" });
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop(true);
  }
});
