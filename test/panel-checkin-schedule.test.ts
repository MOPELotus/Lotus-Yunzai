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
import { checkinScheduleClock, generateCheckinSchedulePlan, type CheckinScheduleConfig } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleRuntime } from "../lib/checkin-schedule-runtime.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";

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
      "  random: {window_start: '07:00', window_end: '17:00', notify_before: false, unrelated: fixture-hidden-random}",
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
      random: { window_start: "07:00", window_end: "17:00", notify_before: false },
      late_registration: { window_start: "23:30", window_end: "23:59", enable: false, notify: true },
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
    expect(changed.settings).toEqual({
      ...before.settings, ...patch, catch_up_cron: "0 */10 * * * *",
    });
    expect(await (await api(request()))!.json()).toEqual(changed);
    expect((await api(request("PUT", { revision: before.revision, patch: { enable: false } })))?.status).toBe(409);
    expect(await readFile(inherited, "utf8")).toBe(original);
    expect(await readFile(canonical, "utf8")).toStartWith(local);
    expect((await readLotusGlobalConfig(root)).scheduler).toMatchObject({
      ...changed.settings, late_registration: { enable: false },
    });
    const window = { revision: changed.revision, patch: { random: { window_end: "18:30" } } };
    expect((await api(request("PUT", { ...window, patch: { random: { window_end: "06:42" } } })))?.status).toBe(422);
    expect((await api(request("PUT", { ...window, patch: { random: { notify_before: "false" } } })))?.status).toBe(400);
    expect((await api(request("PUT", { ...window, patch: { random: { unknown: true } } })))?.status).toBe(400);
    const updated = await api(request("PUT", window));
    expect(updated?.status).toBe(200);
    expect(await updated!.json()).toMatchObject({
      settings: { random: { window_start: "07:00", window_end: "18:30", notify_before: false } },
    });
    expect((await api(request("PUT", { ...window, patch: { random: { window_start: "08:00" } } })))?.status).toBe(409);
    expect(await readFile(inherited, "utf8")).toBe(original);
    expect(await readFile(canonical, "utf8")).not.toContain("fixture-hidden-random");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("日期语法无效的旧 Cron 只显示实际默认规则", () => {
  expect(checkinSchedulePanelSnapshot({ run_due_cron: "fixture-secret", plan_generate_cron: "0 10 1 * * ? *" }))
    .toMatchObject({ invalidCrons: ["run_due_cron"], settings: { run_due_cron: "0 * * * * *", plan_generate_cron: "0 10 1 * * ? *" } });
});

test("随机与补注册配置保留别名、共有原值、注释和外部字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-panel-alias-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const original = "\uFEFF# 保留 UTF-8 文档\r\n";
    await writeFile(file, original + [
      "defaults: &random {window_start: '08:00', window_end: '13:00', notify_before: false, extra: retained}",
      "scheduler:",
      "  random: *random  # 保留共用来源",
      "  late_registration:",
      "    window_start: '22:30'  # 保留窗口注释",
      "    window_end: '23:59'",
      "other: *random",
      "",
    ].join("\r\n"));
    const handle = panelCheckinSchedule(root);
    const before = await (await handle(request(), () => true)).json() as CheckinSchedulePanelSnapshot;
    const saved = await handle(request("PUT", { revision: before.revision, patch: {
      random: { notify_before: true },
      late_registration: { window_start: "21:30", window_end: "22:58", enable: false, notify: false },
    } }), () => true);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      settings: {
        random: { window_start: "08:00", window_end: "13:00", notify_before: true },
        late_registration: { window_start: "21:30", window_end: "22:58", enable: false, notify: false },
      },
    });
    const bytes = await readFile(file, "utf8");
    expect(bytes).toStartWith(original);
    expect(bytes).toContain("random: {<<: *random, notify_before: true}  # 保留共用来源\r\n");
    expect(bytes).toContain("window_start: '21:30'  # 保留窗口注释\r\n");
    expect(bytes).toContain("other: *random\r\n");
    const document = Bun.YAML.parse(bytes) as {
      other: { notify_before: boolean }; defaults: { notify_before: boolean };
      scheduler: { random: { extra: string } };
    };
    expect(document.other).toEqual(document.defaults);
    expect(document.other.notify_before).toBe(false);
    expect(document.scheduler.random.extra).toBe("retained");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("面板保存的窗口被真实计划生成、随机和固定补注册以及通知读取", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-schedule-runtime-"));
  const signal = new AbortController();
  let runtime: ReturnType<typeof createCheckinScheduleRuntime> | undefined;
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    await writeFile(join(directory, "config/global.yaml"), "scheduler: {mode: random, enable: true, run_due_cron: '0 0 4 * * ? *'}\n");
    const route = panelCheckinSchedule(root);
    const initial = await (await route(request(), () => true)).json() as CheckinSchedulePanelSnapshot;
    const submitted = await route(request("PUT", { revision: initial.revision, patch: {
      random: { window_start: "09:10", window_end: "09:10", notify_before: false },
      late_registration: { window_start: "21:20", window_end: "21:25", notify: true },
    } }), () => true);
    expect(submitted.status).toBe(200);
    const config = (await readLotusGlobalConfig(root)).scheduler as CheckinScheduleConfig;
    let now = Date.UTC(2026, 10, 22, 13);
    const { date, tomorrow } = checkinScheduleClock(now);
    const seed = { qq: "10001", profileId: 2, enabled: true };
    const late = { qq: "10002", enabled: true };
    const fixed = { qq: "10003", enabled: true, schedule: { mode: "fixed" as const, fixedTime: "18:45" } };
    const rawStore = createCheckinScheduleStore(join(directory, "plans"));
    await rawStore.update(date, () => ({ result: undefined, plan: generateCheckinSchedulePlan({ date, profiles: [seed], config, now }) }));
    const tomorrowReady = Promise.withResolvers<void>();
    const notified: { qq: string; date: string; late: boolean }[] = [];
    const store: typeof rawStore = { ...rawStore, async update(day, change) {
      const result = await rawStore.update(day, change);
      if (day === tomorrow && result && typeof result === "object" && "entries" in result) tomorrowReady.resolve();
      return result;
    } };
    runtime = createCheckinScheduleRuntime({
      store, config, now: () => now, signal: signal.signal, listProfiles: async () => [seed], startupCatchUpDelayMs: 0,
      runProfile: async () => { throw new Error("no scheduled external requests"); },
      async onNotice(entry, day, lateNotice) {
        notified.push({ qq: entry.qq, date: day, late: lateNotice });
        return { status: "confirmed" };
      },
    });
    runtime.start();
    const deadline = setTimeout(() => tomorrowReady.reject(new Error("未生成次日计划。")), 2_000);
    try { await tomorrowReady.promise; } finally { clearTimeout(deadline); }
    expect((await store.read(tomorrow))?.entries).toMatchObject([{ qq: seed.qq, time: "09:10" }]);
    expect(notified).toEqual([]);
    await runtime.addRegisteredProfile(late);
    expect((await store.read(date))?.entries.find(entry => entry.qq === late.qq))
      .toMatchObject({ time: "21:20", mode: "late_random" });
    expect(notified).toContainEqual({ qq: late.qq, date, late: true });

    now += 26 * 60_000;
    const snapshot = await (await route(request(), () => true)).json() as CheckinSchedulePanelSnapshot;
    expect((await route(request("PUT", { revision: snapshot.revision, patch: {
      late_registration: { notify: false },
    } }), () => true)).status).toBe(200);
    runtime.updateConfig((await readLotusGlobalConfig(root)).scheduler as CheckinScheduleConfig);
    const eligibleTomorrow = { qq: "10004", enabled: true };
    await runtime.addRegisteredProfile(eligibleTomorrow);
    expect((await store.read(date))?.entries.find(entry => entry.qq === eligibleTomorrow.qq)).toBeUndefined();
    expect((await store.read(tomorrow))?.entries.find(entry => entry.qq === eligibleTomorrow.qq))
      .toMatchObject({ time: "21:21", mode: "late_random" });
    await runtime.addRegisteredProfile(fixed);
    expect((await store.read(date))?.entries.find(entry => entry.qq === fixed.qq))
      .toMatchObject({ time: "18:45", mode: "fixed" });
    expect(notified.some(entry => entry.qq === fixed.qq || entry.qq === eligibleTomorrow.qq)).toBe(false);
    const reloaded = await (await route(request(), () => true)).json() as CheckinSchedulePanelSnapshot;
    expect((await route(request("PUT", { revision: reloaded.revision, patch: {
      late_registration: { enable: false },
    } }), () => true)).status).toBe(200);
    runtime.updateConfig((await readLotusGlobalConfig(root)).scheduler as CheckinScheduleConfig);
    await runtime.addRegisteredProfile({ ...fixed, qq: "10005" });
    expect((await store.read(tomorrow))?.entries.find(entry => entry.qq === "10005")).toBeUndefined();
  } finally {
    signal.abort();
    await runtime?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("顶级共享 scheduler 只覆盖选中的窗口，不重写其他别名消费者", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-schedule-alias-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    await writeFile(file, [
      "shared: &schedule",
      "  mode: random",
      "  random: {window_start: '08:42', window_end: '17:21', extra: preserved}",
      "scheduler: *schedule  # 保留注释",
      "untouched: *schedule",
      "",
    ].join("\n"));
    const route = panelCheckinSchedule(root);
    const snapshot = await (await route(request(), () => true)).json() as CheckinSchedulePanelSnapshot;
    const response = await route(request("PUT", { revision: snapshot.revision, patch: {
      random: { window_end: "18:23" },
    } }), () => true);
    expect(response.status).toBe(200);
    const bytes = await readFile(file, "utf8");
    expect(bytes).toContain("scheduler: {<<: *schedule, random:");
    expect(bytes).toContain("# 保留注释\nuntouched: *schedule\n");
    expect(Bun.YAML.parse(bytes)).toMatchObject({
      scheduler: { mode: "random", random: { window_start: "08:42", window_end: "18:23", extra: "preserved" } },
      untouched: { mode: "random", random: { window_start: "08:42", window_end: "17:21", extra: "preserved" } },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
