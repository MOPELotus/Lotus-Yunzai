import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkinSchedulePanelSnapshot } from "../lib/checkin-schedule-settings.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelCheckinSchedule } from "../lib/panel-checkin-schedule.ts";
import type { CheckinSchedulePanelSnapshot } from "../lib/panel-checkin-schedule-schema.ts";
import { panelApi } from "../lib/panel.ts";

const endpoint = "/panel/api/settings/checkin/schedule";

function request(method = "GET", data?: unknown, token = "panel-fixture") {
  return new Request(`http://localhost${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

test("签到调度按运行配置投影和保存六个字段，保留旧窗口、配置字节及授权", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-panel-"));
  try {
    const root = pathToFileURL(directory + "/");
    const inheritedDirectory = join(directory, "plugins", "Lotus-Plugin", "config");
    await mkdir(inheritedDirectory, { recursive: true });
    await mkdir(join(directory, "config"));
    const inherited = join(inheritedDirectory, "global.yaml");
    const original = [
      "scheduler:",
      "  enable: false",
      "  mode: fixed",
      "  plan_generate_cron: '0 8 9 * * ? *'",
      "  run_due_cron: '0 */3 * * * *'",
      "  catch_up_cron: ''",
      "  random: {window_start: '07:00', window_end: '17:00', notify_before: false}",
      "  late_registration: {enable: false}",
      "  other: fixture-hidden-config",
    ].join("\n") + "\n";
    await writeFile(inherited, original);
    const canonical = join(directory, "config", "global.yaml");
    const local = "# 保留 CRLF 的非公开字段\r\nother: fixture-private-value\r\n";
    await writeFile(canonical, local);

    const handle = panelCheckinSchedule(root);
    const api = panelApi("panel-fixture", [], path => path === endpoint ? handle : undefined);
    expect((await api(request("GET", undefined, "wrong")))?.status).toBe(401);
    expect((await api(request("POST")))?.status).toBe(405);
    const initial = await api(request());
    expect(initial?.headers.get("Cache-Control")).toBe("no-store");
    const before = await initial!.json() as CheckinSchedulePanelSnapshot;
    expect(before.settings).toEqual({
      enable: false, mode: "fixed", fixed_time: "04:30", plan_generate_cron: "0 8 9 * * ? *",
      run_due_cron: "0 */3 * * * *", catch_up_cron: "0 */10 * * * *",
    });
    expect(JSON.stringify(before)).not.toContain("fixture-");

    const patch = {
      enable: true, mode: "random" as const, fixed_time: "07:40", plan_generate_cron: "0 17 11 * * ? *",
      run_due_cron: "*/5 * * * *", catch_up_cron: "",
    };
    expect((await api(request("PUT", { revision: before.revision, patch: { ...patch, private: true } })))?.status).toBe(400);
    expect((await api(request("PUT", { revision: before.revision, patch: { ...patch, run_due_cron: "0 70 * * * *" } })))?.status).toBe(400);
    expect((await api(request("PUT", { revision: before.revision, patch: { ...patch, fixed_time: "25:40" } })))?.status).toBe(400);
    let authorized = 0;
    expect((await handle(request("PUT", { revision: before.revision, patch }), () => ++authorized === 1)).status).toBe(401);
    expect(await readFile(canonical, "utf8")).toBe(local);

    const saved = await api(request("PUT", { revision: before.revision, patch }));
    expect(saved?.status).toBe(200);
    const changed = await saved!.json() as CheckinSchedulePanelSnapshot;
    expect(changed.settings).toEqual({ ...patch, catch_up_cron: "0 */10 * * * *" });
    expect(await (await api(request()))!.json()).toEqual(changed);
    expect((await api(request("PUT", { revision: before.revision, patch: { enable: false } })))?.status).toBe(409);
    expect(await readFile(inherited, "utf8")).toBe(original);
    expect(await readFile(canonical, "utf8")).toStartWith(local);
    expect((await readLotusGlobalConfig(root)).scheduler).toMatchObject({
      ...changed.settings, random: { window_start: "07:00", window_end: "17:00", notify_before: false },
      late_registration: { enable: false },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("日期语法无效的旧 Cron 只显示实际默认规则", () => {
  expect(checkinSchedulePanelSnapshot({ run_due_cron: "fixture-secret", plan_generate_cron: "0 10 1 * * ? *" }))
    .toMatchObject({ invalidCrons: ["run_due_cron"], settings: { run_due_cron: "0 * * * * *", plan_generate_cron: "0 10 1 * * ? *" } });
});
