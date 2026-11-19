import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { extensionBridge } from "../lib/panel-extension-bridge.ts";
import { panelExtensionRoutes } from "../lib/panel-extension-routes.ts";

function sandboxedWindow() {
  const frame: { localStorage: Storage; __GUOBA__?: unknown } = {
    get localStorage(): Storage { throw new DOMException("Opaque origin", "SecurityError"); },
  };
  return frame;
}

test("无接口的锅巴扩展也能使用隔离的临时存储，不开放表单请求", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-extension-storage-"));
  try {
    const directory = join(root, "webadapter");
    await mkdir(directory);
    await writeFile(join(directory, "page.json"), JSON.stringify({
      id: "theme", title: "主题", html: "<script>localStorage.getItem('theme');</script>",
    }));
    const routes = panelExtensionRoutes(new Map([["fixture", { path: root, packageName: "fixture" }]]));
    const origin = "http://fixture.test";
    const open = "/panel/api/extensions/theme/open";
    const response = await routes.api(open)!(new Request(origin + open, { method: "POST" }));
    const ticket = new URL((await response.json()).url, origin);
    expect(ticket.search).toBe("");
    const frame = await routes.assets(new Request(ticket));
    const policy = frame?.headers.get("Content-Security-Policy") ?? "";
    expect(policy).toContain("sandbox allow-scripts allow-forms;");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).not.toContain("connect-src");
    const body = await frame?.text() ?? "";
    const bridge = /src="(\/panel\/extensions-bridge\/[^"]+)"/u.exec(body)?.[1];
    expect(bridge).toBeDefined();
    expect(body.indexOf(bridge!)).toBeLessThan(body.indexOf("localStorage.getItem"));
    const script = await routes.assets(new Request(origin + bridge));
    expect(script?.status).toBe(200);
    const source = await script!.text();
    const first = sandboxedWindow();
    const second = sandboxedWindow();
    runInNewContext(source, { window: first });
    runInNewContext(source, { window: second });
    expect(first.__GUOBA__).toBeUndefined();
    first.localStorage.setItem("theme", "cool");
    expect(first.localStorage.length).toBe(1);
    expect(first.localStorage.key(0)).toBe("theme");
    expect(first.localStorage.getItem("theme")).toBe("cool");
    expect(second.localStorage.getItem("theme")).toBeNull();
    first.localStorage.removeItem("theme");
    expect(first.localStorage.getItem("theme")).toBeNull();
    first.localStorage.setItem("theme", "warm");
    first.localStorage.clear();
    expect(first.localStorage.length).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("扩展脚本执行前恢复原 hash，并限量同步同一帧的数据", () => {
  const frame = sandboxedWindow();
  const data = JSON.stringify([["theme", "cool"]]);
  const location = new URL("https://fixture.test/panel/extensions/theme/page.html?token=fixture");
  const hash = "#tab=foo%20bar";
  location.hash = "#lotus-frame:" + encodeURIComponent(JSON.stringify({ nonce: "fixture", hash, data }));
  const messages: unknown[] = [];
  const window = Object.assign(frame, {
    location,
    history: { replaceState(_: unknown, __: string, url: string) { location.href = url; } },
    parent: { postMessage(value: unknown, origin: string) { messages.push({ value, origin }); } },
  });
  runInNewContext(extensionBridge(), { window, URL, TextEncoder });
  expect(location.hash).toBe(hash);
  expect(location.searchParams.get("token")).toBe("fixture");
  expect(frame.localStorage.getItem("theme")).toBe("cool");
  frame.localStorage.setItem("theme", "warm");
  expect(messages).toEqual([{
    origin: "https://fixture.test",
    value: { type: "lotus-frame-storage", nonce: "fixture", data: '[["theme","warm"]]' },
  }]);
  frame.localStorage.setItem("big", "一".repeat(1500));
  expect(messages).toHaveLength(1);
  frame.localStorage.clear();
  expect(messages).toHaveLength(2);
});
