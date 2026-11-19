import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelExtensionRoutes } from "../lib/panel-extension-routes.ts";
import { panelApi } from "../lib/panel.ts";

test("经过面板鉴权的扩展重扫原子切换目录与 API，在途调用保留旧注册", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-ext-reload-"));
  const key = `panel-reload-${crypto.randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  const oldStarted = Promise.withResolvers<void>();
  const oldReleased = Promise.withResolvers<void>();
  const scanStarted = Promise.withResolvers<void>();
  const scanReleased = Promise.withResolvers<void>();
  const state = { oldStarted, oldReleased, scanStarted, scanReleased, scans: 0 };
  globals[key] = state;

  try {
    const plugin = join(root, "loaded");
    await mkdir(join(plugin, "webadapter"), { recursive: true });
    const descriptor = join(plugin, "webadapter", "index.js");
    await writeFile(descriptor, `
      const fixture = globalThis[${JSON.stringify(key)}];
      export function init(ctx) {
        ctx.registerPage({ id: "same", title: "旧动态扩展", html: "<h1>旧页面</h1>" });
        ctx.registerApi("get", "/version", async (req, res) => {
          if (req.query.hold === "yes") {
            fixture.oldStarted.resolve();
            await fixture.oldReleased.promise;
          }
          res.json({ version: "old" });
        });
      }
    `);
    const excluded = join(root, "excluded", "guoba");
    await mkdir(excluded, { recursive: true });
    await writeFile(join(excluded, "index.js"), `throw new Error("此插件未加载");`);
    const routes = panelExtensionRoutes(new Map([["loaded", { path: plugin, packageName: "fixture" }]]));
    const api = panelApi("panel-fixture", [], routes.api);
    const rootUrl = "http://127.0.0.1:9876";
    const request = (path: string, method = "GET", authorized = true) => api(new Request(rootUrl + path, {
      method, headers: authorized ? { Authorization: "Bearer panel-fixture" } : {},
    }));
    const version = (token: string, query = "") => routes.assets(new Request(
      `${rootUrl}/panel/extensions-api/same/version${query}`, { headers: { Origin: "null", "guoba-access-token": token } },
    ));
    const open = async () => {
      const response = await request("/panel/api/extensions/same/open", "POST");
      return new URL((await response?.json() as { url: string }).url, rootUrl);
    };

    const initial = await request("/panel/api/extensions");
    expect(await initial?.json()).toEqual({
      pages: [{ id: "same", plugin: "loaded", title: "旧动态扩展", priority: 100 }], issues: [],
    });
    const old = await open();
    const oldToken = old.searchParams.get("token") ?? "";
    expect(await (await routes.assets(new Request(old)))?.text()).toContain("旧页面");
    const inFlight = version(oldToken, "?hold=yes");
    await Promise.race([oldStarted.promise, inFlight.then(() => { throw new Error("旧接口没有进入处理函数。"); })]);

    await writeFile(descriptor, `
      const fixture = globalThis[${JSON.stringify(key)}];
      export async function init(ctx) {
        fixture.scans++;
        ctx.registerPage({ id: "same", title: "新动态扩展", html: "<h1>新页面</h1>" });
        ctx.registerPage({ id: "extra", title: "新增入口", html: "<h1>新增页面</h1>" });
        ctx.registerApi("get", "/version", (_req, res) => res.json({ version: "new" }));
        fixture.scanStarted.resolve();
        await fixture.scanReleased.promise;
      }
    `);
    expect((await request("/panel/api/extensions/reload", "POST", false))?.status).toBe(401);
    expect((await request("/panel/api/extensions/reload"))?.status).toBe(405);
    expect(state.scans).toBe(0);

    const first = request("/panel/api/extensions/reload", "POST");
    await Promise.race([scanStarted.promise, first.then(() => { throw new Error("重扫没有执行新描述符。"); })]);
    const second = request("/panel/api/extensions/reload", "POST");
    expect(await (await request("/panel/api/extensions"))?.json()).toMatchObject({
      pages: [{ id: "same", title: "旧动态扩展" }],
    });
    expect(await (await version(oldToken))?.json()).toEqual({ version: "old" });
    scanReleased.resolve();
    for (const operation of [first, second]) {
      expect(await (await operation)?.json()).toMatchObject({
        pages: [{ id: "same", title: "新动态扩展" }, { id: "extra", title: "新增入口" }], issues: [],
      });
    }
    expect(state.scans).toBe(1);
    expect((await routes.assets(new Request(old)))?.status).toBe(404);
    expect((await version(oldToken))?.status).toBe(401);
    const fresh = await open();
    expect(await (await routes.assets(new Request(fresh)))?.text()).toContain("新页面");
    expect(await (await version(fresh.searchParams.get("token") ?? ""))?.json()).toEqual({ version: "new" });

    oldReleased.resolve();
    expect(await (await inFlight)?.json()).toEqual({ version: "old" });
  } finally {
    scanReleased.resolve();
    oldReleased.resolve();
    delete globals[key];
    await rm(root, { recursive: true, force: true });
  }
});
