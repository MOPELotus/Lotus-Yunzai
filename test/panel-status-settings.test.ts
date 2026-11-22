import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelApi } from "../lib/panel.ts";
import { panelStatusSettings } from "../lib/panel-status-settings.ts";
import { statusMonitorSettings } from "../plugins/system/status-monitor.ts";

const route = "/panel/api/settings/native/status";

async function fixture(run: (root: URL, write: (path: string, text: string) => Promise<string>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-status-"));
  const previous = Bun.env.LOTUS_SYSTEM_STATUS_CONFIG;
  delete Bun.env.LOTUS_SYSTEM_STATUS_CONFIG;
  try {
    await run(pathToFileURL(directory + "/"), async (path, text) => {
      const file = join(directory, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
      return file;
    });
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_SYSTEM_STATUS_CONFIG;
    else Bun.env.LOTUS_SYSTEM_STATUS_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function requests(root: URL) {
  const api = panelApi("test-status", [], path => path === route ? panelStatusSettings(root) : undefined);
  return async (method = "GET", data?: unknown, token = "test-status") => {
    const response = await api(new Request("http://localhost" + route, {
      method, headers: { Authorization: "Bearer " + token, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    }));
    return response!;
  };
}

test("状态面板继承旧配置，修改现行字段不改旧文件或无关 YAML", () => fixture(async (root, write) => {
  const legacy = await write("plugins/yenai-plugin/config/config/state.yaml",
    "defaultState: true\nnoPro: true\nsystemResources: [CPU, Node, GPU]\nmonitor: {open: false, saveDataNumber: 17}\n");
  const original = "# 保留注释\ncustom: old\nmonitor: {getDataInterval: 2000, extra: keep}\n";
  const file = await write("config/system-status.yaml", original);
  const get = requests(root);
  const response = await get();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const { values, fields } = await response.json();
  expect(values).toMatchObject({
    defaultState: true, noPro: true, systemResources: ["CPU", "Bun", "GPU"],
    "monitor.open": false, "monitor.getDataInterval": 2000, "monitor.saveDataNumber": 17,
  });
  expect(fields.find((field: { key: string }) => field.key === "monitor.open").hint).toContain("重启");
  const change = { previous: values, values: { ...values, noPro: false, "monitor.saveDataNumber": 70 } };
  expect((await get("PUT", change, "other")).status).toBe(401);
  expect((await get("POST")).status).toBe(405);
  expect((await get("PUT", change)).status).toBe(200);
  const written = await readFile(file, "utf8");
  expect(written).toContain("# 保留注释");
  const local = Bun.YAML.parse(written) as Record<string, unknown>;
  expect(local).toEqual({ custom: "old", noPro: false, monitor: { getDataInterval: 2000, extra: "keep", saveDataNumber: 70 } });
  expect(statusMonitorSettings(local)).toMatchObject({ interval: 2000, limit: 70 });
  expect(await readFile(legacy, "utf8")).toContain("saveDataNumber: 17");
  expect((await get("PUT", change)).status).toBe(409);
  expect(await (await get()).json()).toMatchObject({ values: { noPro: false, "monitor.open": false, "monitor.saveDataNumber": 70 } });
}));

test("状态面板沿用显式部署文件，保护锚点配置且不返回代理或 URL 中的秘密", () => fixture(async (root, write) => {
  await write("config/system-status.yaml", "defaultState: true\n");
  const file = await write("custom/state.yaml", [
    "defaults: &defaults", "  open: false", "  getDataInterval: 2000", "monitor: *defaults",
    "psTestSites:", "  show: pro", "  proxy: https://user:private@proxy.example.com",
    '  list: [{name: 公共站, url: "https://example.com/"}, {name: 私有参数, url: "https://example.com/?secret=token"}]',
  ].join("\n") + "\n");
  Bun.env.LOTUS_SYSTEM_STATUS_CONFIG = file;
  const get = requests(root);
  const { values } = await (await get()).json();
  expect(values).toMatchObject({ defaultState: false, "monitor.open": false, "monitor.getDataInterval": 2000 });
  expect(values["psTestSites.list"]).toEqual([{ name: "公共站", url: "https://example.com/", useProxy: false }]);
  expect(JSON.stringify(values)).not.toMatch(/private|secret|token/u);
  const save = await get("PUT", { previous: values, values: { ...values, "monitor.open": true, "monitor.saveDataNumber": 20 } });
  expect(save.status).toBe(200);
  const saved = Bun.YAML.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  expect(saved.defaults).toEqual({ open: false, getDataInterval: 2000 });
  expect(saved.monitor).toEqual({ open: true, getDataInterval: 2000, saveDataNumber: 20 });
  expect(saved.psTestSites).toMatchObject({ proxy: "https://user:private@proxy.example.com", list: [{ name: "公共站" }, { name: "私有参数" }] });
  expect(await readFile(new URL("config/system-status.yaml", root), "utf8")).toBe("defaultState: true\n");
}));

test("拒绝无效设置、不可编辑字段和失效写入授权", () => fixture(async (root, write) => {
  const file = await write("config/system-status.yaml", "defaultState: false\n");
  const get = requests(root);
  const { values } = await (await get()).json();
  for (const invalid of [
    { "monitor.getDataInterval": 0 }, { "monitor.saveDataNumber": 721 }, { "psTestSites.proxy": "https://example.com/" },
    { "style.backdropDefault": "../account.png" }, { systemResources: ["Disk"] },
    { "psTestSites.list": [{ name: "内网", url: "https://127.0.0.1/", useProxy: false }] },
    { "psTestSites.list": [{ name: "登陆", url: "https://a.example/?token=1", useProxy: false }] },
  ]) {
    const response = await get("PUT", { previous: values, values: { ...values, ...invalid } });
    expect(response.status).toBe(400);
  }
  const request = new Request("http://localhost" + route, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previous: values, values: { ...values, defaultState: true } }),
  });
  let calls = 0;
  expect((await panelStatusSettings(root)(request, () => ++calls < 3)).status).toBe(401);
  expect(await readFile(file, "utf8")).toBe("defaultState: false\n");
}));
