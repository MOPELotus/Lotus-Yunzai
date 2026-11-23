import { RedisClient } from "bun";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelNoticeMysSettings, panelNoticeSettings } from "../lib/panel-notice-settings.ts";
import { panelNoticeDeliverySettings } from "../lib/panel-notice-delivery-settings.ts";
import { effectiveAnnouncementTargets } from "../plugins/notice/mys-announcement.ts";
import { configuredAnnouncements } from "../plugins/notice/mys-announcement-config.ts";
import { configuredNoticeLogLevel, configuredNoticeSchedule } from "../plugins/notice/schedule.ts";
import { createTargetStore } from "../plugins/notice/targets.ts";

type Settings = ReturnType<typeof panelNoticeSettings>;
const url = "https://panel.invalid/panel/api/settings/notice";

function get(settings: Settings, authorized = () => true) {
  return settings(new Request(url), authorized);
}

function put(settings: Settings, previous: unknown, values: unknown, authorized = () => true) {
  return settings(new Request(url, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previous, values }),
  }), authorized);
}

test("公告定时面板沿用旧覆盖，保存到现用配置并保持旧原件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-notice-panel-"));
  try {
    const root = pathToFileURL(directory + "/");
    const legacy = join(directory, "plugins/Notice-plugin/config");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "config_default.yaml"), "enableSchedule: true\nscheduleTime: 8:00-8:30\nother: preserve\n");
    const current = "scheduleTime: 9:10-10:00\nlogger: warn\n";
    await writeFile(join(legacy, "config.yaml"), current);
    const settings = panelNoticeSettings(root);
    expect((await get(settings, () => false)).status).toBe(401);
    const values = (await (await get(settings)).json()).values;
    expect(values).toEqual({ enableSchedule: true, scheduleTime: "9:10-10:00", logger: "warn" });
    expect((await put(settings, values, { scheduleTime: "25:30-32:00" })).status).toBe(400);
    expect((await put(settings, values, { logger: "invalid" })).status).toBe(400);
    expect((await put(settings, values, { scheduleTime: "11:05-11:21" }, () => false)).status).toBe(401);
    expect(await Bun.file(join(directory, "config/notice.yaml")).exists()).toBe(false);
    const response = await put(settings, values, { scheduleTime: "11:05-11:21", logger: "debug" });
    expect(response.status).toBe(200);
    expect((await response.json()).warning).toContain("重启");
    expect(configuredNoticeSchedule(root, "")).toEqual({ start: 665, end: 681 });
    expect(configuredNoticeLogLevel(root, "")).toBe("debug");
    expect(await readFile(join(legacy, "config.yaml"), "utf8")).toBe(current);
    expect(Bun.YAML.parse(await readFile(join(directory, "config/notice.yaml"), "utf8"))).toEqual({
      enableSchedule: true, scheduleTime: "11:05-11:21", logger: "debug", other: "preserve",
    });
    expect((await put(settings, values, { enableSchedule: false })).status).toBe(409);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("未配置定时推送时保存窗口不会顺带启用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-notice-panel-empty-"));
  try {
    const root = pathToFileURL(directory + "/");
    const settings = panelNoticeSettings(root);
    const values = (await (await get(settings)).json()).values;
    expect(values).toEqual({ enableSchedule: false, scheduleTime: "8:00-8:30", logger: "info" });
    expect((await put(settings, values, { scheduleTime: "15:05-15:21" })).status).toBe(200);
    expect(configuredNoticeSchedule(root, "")).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("米游社面板编辑热读目标、筛选与限制，Cron 单独校验并保留无关字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-mys-panel-"));
  try {
    const root = pathToFileURL(directory + "/");
    const path = join(directory, "config/mys.pushNews.yaml");
    await mkdir(join(directory, "config"));
    await writeFile(path, "# 保留\nbanWord:\n  gs: 旧过滤\n  sr: 星铁旧词 # 保留此注释\nlocalExtension: 73\n");
    const settings = panelNoticeMysSettings(root, (cron) => cron === "0 0/5 * * * ?" || cron === "0 */7 * * * *");
    const snapshot = await (await get(settings)).json();
    const { values, fields } = snapshot;
    expect(fields).toHaveLength(13);
    expect(values.gsBanWord).toBe("旧过滤");
    expect(values).not.toHaveProperty("localExtension");
    expect((await put(settings, values, { pushTime: "bad cron" })).status).toBe(400);
    expect((await put(settings, values, { gsAnnounceGroup: { "__proto__": [1] } })).status).toBe(400);
    expect((await put(settings, values, { gsinfoGroup: { 4: ["9", 9] } }, () => false)).status).toBe(401);
    const runtime = configuredAnnouncements(root);
    expect(runtime().maxNum).toBe(1);
    const update = { maxNum: 0, pushTime: "0 */7 * * * *", gsBanWord: "", gsinfoGroup: { 4: ["9", 9] }, srActivityPush: { 4: [10] } };
    const response = await put(settings, values, update);
    expect(response.status).toBe(200);
    expect((await response.json()).warning).toContain("重启");
    expect(runtime().cron).toBe("0 */7 * * * *");
    expect(runtime().infoTargets.gs).toEqual([{ botId: 4, groupId: 9 }]);
    expect(runtime().activityTargets.sr).toEqual([{ botId: 4, groupId: 10 }]);
    expect(runtime().maxNum).toBe(0);
    expect(runtime().ban.gs).toBeUndefined();
    expect(runtime().ban.sr?.source).toBe("星铁旧词");
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("localExtension: 73");
    expect(saved).toContain("sr: 星铁旧词 # 保留此注释");
    expect((await put(settings, values, { maxNum: 5 })).status).toBe(409);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const valkeyServer = Bun.which("valkey-server");
test.skipIf(!valkeyServer)("公告面板的 Valkey 设置原子更新，与旧聊天名单、账号及米游社覆盖共用原键", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-notice-valkey-panel-"));
  const socket = join(directory, "db.sock");
  const server = Bun.spawn([valkeyServer!, "--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no"], {
    stdout: "ignore", stderr: "ignore",
  });
  const client = new RedisClient(`redis+unix://${socket}`, { autoReconnect: false });
  let injectRace = false;
  try {
    let connected = false;
    for (let i = 0; i < 50; i++) {
      try { await client.connect(); connected = true; break; }
      catch { await Bun.sleep(10); }
    }
    expect(connected).toBe(true);
    const redis = {
      async eval(script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) {
        if (injectRace && args.length > 1) {
          await client.send("SADD", ["notice:whitelist", "99"]);
          injectRace = false;
        }
        return await client.send("EVAL", [script, String(keys.length), ...keys, ...args]);
      },
      async hGetAll(key: string) {
        return await client.hgetall(key) as Record<string, string>;
      },
    };
    const infoKey = "lotus-yunzai:notice:mys:gs:info-targets";
    await client.hset(infoKey, "7:8", "off");
    await client.hset(infoKey, "bad", "legacy");
    await client.hset("notice:account:7:config", "unknown", "kept");
    let bots = [7];
    const settings = panelNoticeDeliverySettings(() => redis, () => bots);
    const before = (await (await get(settings)).json()).values;
    expect(before.gsinfo).toEqual({ "7:8": "off" });
    expect(before.accounts["7"].retryCount).toBe(3);
    const edit = { whitelist: ["8", "12"], accounts: { 7: { enabled: false, retryCount: 0, blacklist: [12] } },
      gsinfo: { "7:11": "on" } };
    expect((await put(settings, before, edit, () => false)).status).toBe(401);
    expect((await put(settings, before, { accounts: { 9: { pushInterval: 999 } } })).status).toBe(400);
    injectRace = true;
    expect((await put(settings, before, edit)).status).toBe(409);
    expect(await client.hget(infoKey, "7:8")).toBe("off");
    const latest = (await (await get(settings)).json()).values;
    expect(latest.whitelist).toEqual(["99"]);
    const response = await put(settings, latest, edit);
    expect(response.status).toBe(200);
    const live = await createTargetStore(redis).settings("7");
    expect([...live.global.whitelist].sort()).toEqual(["12", "8"]);
    expect(live.account).toMatchObject({ enabled: false, retryCount: 0, blacklist: ["12"] });
    expect(await client.hget("notice:account:7:config", "unknown")).toBe("kept");
    expect(await client.hget(infoKey, "bad")).toBe("legacy");
    expect(await effectiveAnnouncementTargets(redis, [{ botId: 7, groupId: 8 }], infoKey))
      .toEqual([{ botId: 7, groupId: 8 }, { botId: 7, groupId: 11 }]);
    bots = [9];
    expect((await put(settings, (await response.json()).values, edit)).status).toBe(409);
  } finally {
    client.close();
    server.kill();
    await server.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
