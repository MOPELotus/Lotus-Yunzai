import { expect, spyOn, test } from "bun:test";
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

test("必须显式配置正的十进制分钟数，默认和零不调度", async () => {
  const timers = captureTimers();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let runs = 0;
  try {
    for (const config of [{}, { update_time: 0 }, { update_time: "0" }, { update_time: -1 },
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
