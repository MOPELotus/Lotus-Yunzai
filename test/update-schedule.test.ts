import { defaultUpdateCron, withDefaultUpdateSchedule } from "../lib/update-schedule-settings.ts";
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalConfig } from "../lib/config.ts";
import { LegacyTasks } from "../lib/plugins/tasks.ts";
import { scheduleUpdates } from "../lib/update-schedule.ts";

function captureTimers(onSchedule: (count: number) => void = () => {}) {
  const nativeSetTimeout = globalThis.setTimeout;
  const scheduled: { delay: number; handle: ReturnType<typeof setTimeout>; fire: () => void }[] = [];
  const mock = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    const handle = nativeSetTimeout(() => {}, 60_000);
    scheduled.push({ delay, handle, fire: () => { clearTimeout(handle); callback(); } });
    onSchedule(scheduled.length);
    return handle;
  }) as typeof setTimeout);
  return {
    scheduled,
    restore() {
      mock.mockRestore();
      for (const { handle } of scheduled) clearTimeout(handle);
    },
  };
}

test("显式零停用更新，非法分钟间隔不调度", async () => {
  const timers = captureTimers();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let runs = 0;
  try {
    for (const config of [{ update_time: 0 }, { update_time: "0" }, { update_time: -1 },
      { update_time: "0xF" }, { update_time: "1e3" }, { update_time: Number.MAX_SAFE_INTEGER }]) {
      await scheduleUpdates(config, () => { runs++; })();
    }
    expect(runs).toBe(0);
    expect(timers.scheduled).toEqual([]);
    expect(warn.mock.calls).toEqual(Array(4).fill(["[任务] 跳过 bot.yaml 中无效的 update_time。"]));
  } finally {
    timers.restore();
    warn.mockRestore();
  }
});

test("现行和旧目录未设时间时默认双次更新，明确配置优先", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-legacy-update-"));
  const legacyPath = join(directory, "config/config/bot.yaml"), modernPath = join(directory, "config/bot.yaml");
  const root = pathToFileURL(directory + "/");
  const read = async () => withDefaultUpdateSchedule(await readLocalConfig(root, "bot"));
  try {
    expect(await read()).toEqual({ update_cron: defaultUpdateCron });
    await mkdir(join(directory, "config/config"), { recursive: true });
    await writeFile(legacyPath, "file_watch: false\n");
    expect(await read()).toEqual({ file_watch: false, update_cron: defaultUpdateCron });
    await writeFile(legacyPath, "update_time: 0\n");
    expect(await read()).toEqual({ update_time: 0 });
    await writeFile(legacyPath, "update_time: 48\n");
    expect(await read()).toEqual({ update_time: 48 });
    await writeFile(modernPath, "update_cron: []\n");
    expect(await read()).toEqual({ update_cron: [] });
    await writeFile(modernPath, "file_watch: false\n");
    expect(await read()).toEqual({ file_watch: false, update_cron: defaultUpdateCron });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("间隔从任务结束开始重计，停止等待当前任务并阻止重新调度", async () => {
  const armedAgain = Promise.withResolvers<void>();
  const timers = captureTimers((count) => { if (count === 2) armedAgain.resolve(); });
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let runs = 0;
  const stop = scheduleUpdates({ update_time: " .0005 " }, () => {
    const index = runs++;
    entered[index]!.resolve();
    return release[index]!.promise;
  });
  try {
    expect(runs).toBe(0);
    expect(timers.scheduled.map(({ delay }) => delay)).toEqual([30]);
    timers.scheduled[0]!.fire();
    await entered[0]!.promise;
    expect(timers.scheduled).toHaveLength(1);
    release[0]!.resolve();
    await armedAgain.promise;
    expect(timers.scheduled.map(({ delay }) => delay)).toEqual([30, 30]);

    timers.scheduled[1]!.fire();
    await entered[1]!.promise;
    const closed = stop();
    expect(stop()).toBe(closed);
    let finished = false;
    void closed.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release[1]!.resolve();
    await closed;
    expect(runs).toBe(2);
    expect(timers.scheduled).toHaveLength(2);
  } finally {
    for (const work of release) work.resolve();
    await stop();
    timers.restore();
  }
});

test("长延迟分段等待，失败后继续计时且不输出底层异常", async () => {
  const armedAgain = Promise.withResolvers<void>();
  const timers = captureTimers((count) => { if (count === 3) armedAgain.resolve(); });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let runs = 0;
  const stop = scheduleUpdates({ update_time: 40_000 }, () => {
    runs++;
    throw new Error("fixture backend detail");
  });
  try {
    expect(timers.scheduled.map(({ delay }) => delay)).toEqual([2_147_483_647]);
    timers.scheduled[0]!.fire();
    expect(timers.scheduled.map(({ delay }) => delay)).toEqual([2_147_483_647, 252_516_353]);
    expect(runs).toBe(0);
    timers.scheduled[1]!.fire();
    await armedAgain.promise;
    expect(runs).toBe(1);
    expect(warn.mock.calls).toEqual([["[任务] 定时更新执行失败。"]]);
    expect(timers.scheduled[2]!.delay).toBe(2_147_483_647);
  } finally {
    await stop();
    warn.mockRestore();
    timers.restore();
  }
});

test("cron 与间隔触发复用进行中的任务，停止后不再启动", async () => {
  const armedAgain = Promise.withResolvers<void>();
  const timers = captureTimers((count) => { if (count === 2) armedAgain.resolve(); });
  const callbacks: { cron: string; fnc: () => Promise<void> | undefined }[] = [];
  const register = spyOn(LegacyTasks.prototype, "register").mockImplementation((_owner, app) => {
    callbacks.push(app.task as (typeof callbacks)[number]);
  });
  const completed = Promise.withResolvers<void>();
  let runs = 0;
  const stop = scheduleUpdates({ update_time: 1, update_cron: ["0 0 1 1 *", "0 15 0 1 1 *"] }, () => {
    runs++;
    return completed.promise;
  });
  try {
    expect(callbacks.map(({ cron }) => cron)).toEqual(["0 0 1 1 *", "0 15 0 1 1 *"]);
    const current = callbacks[0]!.fnc();
    expect(callbacks[1]!.fnc()).toBe(current);
    timers.scheduled[0]!.fire();
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(timers.scheduled).toHaveLength(1);
    completed.resolve();
    await current;
    await armedAgain.promise;
    expect(timers.scheduled.map(({ delay }) => delay)).toEqual([60_000, 60_000]);
    await stop();
    await callbacks[0]!.fnc();
    expect(runs).toBe(1);
  } finally {
    completed.resolve();
    await stop();
    register.mockRestore();
    timers.restore();
  }
});

test("有效的五段及六段 cron 仍可注册，无效配置单独提示", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const stop = scheduleUpdates({ update_cron: ["无效", "0 0 1 1 *", "0 15 0 1 1 *"] }, () => {});
  try {
    expect(warn.mock.calls).toEqual([["[任务] 跳过 bot.yaml 中无效的 update_cron。"]]);
  } finally {
    await stop();
    warn.mockRestore();
  }
});

test("无配置默认北京时间00:30及12:30更新，显式关闭或自定时间优先", async () => {
  const { scheduledJobs } = await import("node-schedule");
  const existing = new Set(Object.keys(scheduledJobs));
  const stop = scheduleUpdates({}, () => {});
  try {
    const job = Object.entries(scheduledJobs).find(([key]) => !existing.has(key))?.[1];
    expect(job).toBeDefined();
    const first = job!.nextInvocation()!;
    const hhmm = (at: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    expect(hhmm(first.getTime())).toMatch(/^(00|12):30$/u);
    job!.invoke();
  } finally { await stop(); }
});
