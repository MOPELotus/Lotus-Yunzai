import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { persistCheckinScheduleSettings } from "../lib/checkin-schedule-settings.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelAtlasChannel } from "../lib/panel-atlas-channel.ts";
import { panelApi } from "../lib/panel.ts";

const route = "/panel/api/settings/atlas/channel";

async function fixture(assertions: (root: URL, write: (path: string, text: string) => Promise<string>) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "lotus-atlas-channel-settings-"));
  const root = pathToFileURL(`${base}/`);
  try {
    await assertions(root, async (path, text) => {
      const file = join(base, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
      return file;
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function requests(root: URL) {
  const api = panelApi("panel-fixture", [], path => path === route ? panelAtlasChannel(root) : undefined);
  return async (method = "GET", data?: unknown, token = "panel-fixture") => {
    const response = await api(new Request(`http://localhost${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(data !== undefined && { "Content-Type": "application/json" }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    }));
    expect(response).toBeDefined();
    return response!;
  };
}

test("面板明确选择图鉴来源，并继承实际生效的旧插件 Atlas 选项", () => fixture(async (root, write) => {
  const current = requests(root);
  const inherited = await write("plugins/Lotus-Plugin/config/global.yaml", "atlas: { update_args: ['--locale', 'zh-cn'], auto_update: { enable: false } }\n");
  const other = await write("plugins/Lotus-ReFactor/config/global.yaml", "atlas: { update_args: ['--locale', 'ja'] }\n");
  const primary = new URL("config/global.yaml", root);
  const before = await current();
  expect(before.headers.get("Cache-Control")).toBe("no-store");
  expect(await before.json()).toEqual({ channel: null });
  expect(await Bun.file(primary).exists()).toBe(false);

  expect((await current("PUT", { previous: null, channel: "latest" }, "other-token")).status).toBe(401);
  expect((await current("PUT", { previous: null, channel: "unsupported" })).status).toBe(400);
  expect((await current("PUT", { previous: null, channel: "live", auto_update: true })).status).toBe(400);
  expect((await current("POST")).status).toBe(405);

  const save = await current("PUT", { previous: null, channel: "live" });
  expect(await save.json()).toEqual({ channel: "live" });
  expect(await readLotusGlobalConfig(root)).toEqual({
    atlas: { update_args: ["--locale", "zh-cn"], auto_update: { enable: false }, version_channel: "live" },
  });
  expect(await readFile(inherited, "utf8")).not.toContain("version_channel");
  expect(await readFile(other, "utf8")).not.toContain("version_channel");
  expect((await current("PUT", { previous: null, channel: "latest" })).status).toBe(409);
  expect(await (await current()).json()).toEqual({ channel: "live" });
}));

test("遵守全局文件优先顺序，并让签到和图鉴的并发保存保留双方设置", () => fixture(async (root, write) => {
  const current = requests(root);
  const nested = await write("config/config/global.yaml", "atlas: { version_channel: latest }\nunknown: preserved\n");
  expect(await (await current()).json()).toEqual({ channel: "latest" });
  const nestedEdit = await current("PUT", { previous: "latest", channel: "live" });
  expect(nestedEdit.status).toBe(200);
  expect(await Bun.file(new URL("config/global.yaml", root)).exists()).toBe(false);
  const legacyBytes = await readFile(nested, "utf8");
  expect(Bun.YAML.parse(legacyBytes)).toEqual({ atlas: { version_channel: "live" }, unknown: "preserved" });

  const primary = await write("config/global.yaml", "# 主配置注释\natlas: { version_channel: live, auto_update: { enable: false } }\npermissions: { default_policy: deny }\n");
  const results = await Promise.all([
    current("PUT", { previous: "live", channel: "latest" }),
    persistCheckinScheduleSettings(root, { type: "mode", mode: "fixed", time: "9:30" }, { canWrite: () => true }),
  ]);
  expect(results[0].status).toBe(200);
  expect(await readLotusGlobalConfig(root)).toEqual({
    atlas: { version_channel: "latest", auto_update: { enable: false } },
    permissions: { default_policy: "deny" },
    scheduler: { mode: "fixed", fixed_time: "09:30" },
  });
  expect(await readFile(primary, "utf8")).toContain("# 主配置注释");
  expect(await readFile(nested, "utf8")).toBe(legacyBytes);
}));
