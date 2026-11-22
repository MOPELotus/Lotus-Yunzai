import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { dailyNoteReminderCooldown, dailyNoteReminderCron } from "../lib/daily-note-reminders.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelDailyNoteSettings } from "../lib/panel-daily-note-settings.ts";
import { panelApi } from "../lib/panel.ts";

const route = "/panel/api/settings/native/daily-note";
const cron = "0 15 8 * * *";
type Values = Record<string, unknown>;
type Snapshot = { readonly fields: readonly { key: string; multiline?: boolean; hint?: string }[]; readonly values: Values; warning?: string };

async function fixture(run: (root: URL, file: (path: string, text: string) => Promise<string>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "lotus-daily-note-panel-"));
  try {
    await run(pathToFileURL(dir + "/"), async (path, text) => {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
      return target;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function request(method = "GET", data?: unknown, token = "daily-note-test") {
  return new Request("http://localhost" + route, {
    method, headers: { Authorization: "Bearer " + token, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

function requests(root: URL, validate: (rule: string) => boolean = dailyNoteReminderCron) {
  const endpoint = panelDailyNoteSettings(root, validate);
  const api = panelApi("daily-note-test", [], path => path === route ? endpoint : undefined);
  return async (method?: string, data?: unknown, token?: string) => (await api(request(method, data, token)))!;
}

test("体力提醒面板区分旧暂停和默认轮询，保留订阅与原全局配置", () => fixture(async (root, file) => {
  const current = await file("config/config/global.yaml", "# 原注释\nversion: 1\ndaily_note_reminders:\n  enable: true\n  cooldown_hours: '2.5'\n  cron: null\n  custom: keep\n");
  const subscription = await file("data/daily-note/reminders.sqlite", "隔离样本保持原字节。");
  const get = requests(root);
  const response = await get();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const { fields, values } = await response.json() as Snapshot;
  expect(values).toEqual({ enable: true, cooldown_hours: 2.5, schedule: "paused", cron: "", message: "" });
  expect(fields.every(field => field.hint?.includes("重启"))).toBe(true);
  expect(fields.find(field => field.key === "message")?.multiline).toBe(true);
  const payload = { previous: values, values: { ...values, schedule: "interval", message: "第一行\r\n第二行" } };
  const save = await get("PUT", payload);
  expect(save.status).toBe(200);
  expect(await save.json()).toMatchObject({ values: { schedule: "interval", message: "第一行\n第二行" }, warning: expect.stringContaining("重启") });
  expect(await readLotusGlobalConfig(root)).toEqual({
    version: 1, daily_note_reminders: { enable: true, cooldown_hours: "2.5", custom: "keep", message: "第一行\n第二行" },
  });
  const source = await readFile(current, "utf8");
  expect(source).toContain("# 原注释");
  expect(await Bun.file(new URL("config/global.yaml", root)).exists()).toBe(false);
  expect(await readFile(subscription, "utf8")).toBe("隔离样本保持原字节。");
  expect((await get("PUT", payload)).status).toBe(409);
}));

test("体力提醒保存保留原共享锚点，定时保存验证真实 Cron 和秒精度", () => fixture(async (root, file) => {
  const shared = "preset: &preset\n  message: 原模板\n  cron: '0 * * * * *'\n  other: extra\ndaily_note_reminders: *preset\n";
  const path = await file("config/global.yaml", shared);
  const validated: string[] = [];
  const get = requests(root, value => { validated.push(value); return dailyNoteReminderCron(value); });
  const { values } = await (await get()).json() as Snapshot;
  expect(values).toMatchObject({ schedule: "cron", cron: "0 * * * * *", message: "原模板" });
  expect((await get("PUT", { previous: values, values: { ...values, enable: true, cooldown_hours: 0.25, cron } })).status).toBe(200);
  expect(validated).toEqual([cron]);
  expect(await readFile(path, "utf8")).toContain("&preset");
  const { daily_note_reminders, preset } = await readLotusGlobalConfig(root);
  expect(preset).toEqual({ message: "原模板", cron: "0 * * * * *", other: "extra" });
  expect(daily_note_reminders).toEqual({ enable: true, cooldown_hours: 0.25, cron, message: "原模板", other: "extra" });
  expect(dailyNoteReminderCooldown(0.25)).toBe(900_000);
  const updated = (await (await get()).json() as Snapshot).values;
  expect((await get("PUT", { previous: updated, values: { ...updated, schedule: "interval" } })).status).toBe(200);
  expect(await readLotusGlobalConfig(root)).toMatchObject({
    preset: { cron: "0 * * * * *" }, daily_note_reminders: { enable: true, other: "extra" },
  });
  expect((await (await get()).json() as Snapshot).values).toMatchObject({ schedule: "interval", cron: "" });
}));

test("体力提醒拒绝非法值、非授权账号和保存中撤回授权", () => fixture(async (root, file) => {
  const initial = "daily_note_reminders: { cron: null }\n";
  const path = await file("config/global.yaml", initial);
  const get = requests(root, () => false);
  const { values } = await (await get()).json() as Snapshot;
  for (const invalid of [
    { cooldown_hours: -1 }, { cooldown_hours: 0.00001 }, { message: "文".repeat(190) }, { message: "\x07" },
    { enabled: true }, { cron }, { schedule: "cron", cron: "0 0 31 * * ?" }, { schedule: "cron", cron },
  ]) expect((await get("PUT", { previous: values, values: { ...values, ...invalid } })).status).toBe(400);
  const payload = { previous: values, values: { ...values, enable: true } };
  expect((await get("PUT", payload, "wrong-token")).status).toBe(401);
  expect((await get("POST")).status).toBe(405);
  let checks = 0;
  expect((await panelDailyNoteSettings(root, dailyNoteReminderCron)(request("PUT", payload), () => ++checks < 3)).status).toBe(401);
  expect(await readFile(path, "utf8")).toBe(initial);
}));
