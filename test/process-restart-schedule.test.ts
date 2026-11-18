import { expect, spyOn, test } from "bun:test";
import { scheduleProcessRestart } from "../lib/process-restart-schedule.ts";
import { LegacyTasks } from "../lib/plugins/tasks.ts";

function captureTimers() {
  const nativeSetTimeout = globalThis.setTimeout;
  const scheduled: { delay: number; handle: ReturnType<typeof setTimeout>; fire: () => void }[] = [];
  const mock = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    const handle = nativeSetTimeout(() => {}, 60_000);
    scheduled.push({ delay, handle, fire: () => { clearTimeout(handle); callback(); } });
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

test("启动后的 restart_time 支持小数数字字符串并只执行一次", async () => {
  let runs = 0;
  const started = Promise.withResolvers<void>();
  const close = scheduleProcessRestart({ restart_time: "0.0005" }, () => { runs++; started.resolve(); });
  try {
    expect(runs).toBe(0);
    await started.promise;
    await Bun.sleep(50);
    expect(runs).toBe(1);
  } finally {
    await close();
  }
});

test("超过系统 timer 上限的重启延迟分段等待，不立即触发", async () => {
  const timers = captureTimers();
  let runs = 0;
  const started = Promise.withResolvers<void>();
  const close = scheduleProcessRestart({ restart_time: 40_000 }, () => { runs++; started.resolve(); });
  try {
    expect(timers.scheduled.map(({ delay }) => delay)).toEqual([2_147_483_647]);
    timers.scheduled[0]!.fire();
    expect(runs).toBe(0);
    expect(timers.scheduled.map(({ delay }) => delay)).toEqual([2_147_483_647, 252_516_353]);
    timers.scheduled[1]!.fire();
    await started.promise;
    expect(runs).toBe(1);
  } finally {
    await close();
    timers.restore();
  }
});

test("同一秒的定时与 cron 共用触发记录，后续时刻仍可触发", async () => {
  const timers = captureTimers();
  const now = spyOn(Date, "now").mockReturnValue(10_000);
  const callbacks: (() => void | Promise<void>)[] = [];
  const register = spyOn(LegacyTasks.prototype, "register").mockImplementation((_owner, app) => {
    callbacks.push((app.task as { fnc: () => void | Promise<void> }).fnc);
  });
  let runs = 0;
  const close = scheduleProcessRestart({ restart_time: 1, restart_cron: "* * * * * *" }, () => { runs++; });
  try {
    await callbacks[0]!();
    timers.scheduled[0]!.fire();
    await Promise.resolve();
    expect(runs).toBe(1);
    now.mockReturnValue(11_000);
    await callbacks[0]!();
    expect(runs).toBe(2);
    await close();
    now.mockReturnValue(12_000);
    await callbacks[0]!();
    expect(runs).toBe(2);
  } finally {
    await close();
    register.mockRestore();
    now.mockRestore();
    timers.restore();
  }
});

test("错误 cron 不影响五段和六段任务，也不影响间隔启动；关闭等待在途", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const close = scheduleProcessRestart({
    restart_time: 0.0005,
    restart_cron: ["无效", false, 0, "0 0 1 1 *", "0 15 0 1 1 *"],
  }, () => { entered.resolve(); return release.promise; });
  try {
    await entered.promise;
    expect(warn.mock.calls).toEqual([["[任务] 跳过 bot.yaml 中无效的 restart_cron。"]]);
    const finished = close();
    expect(close()).toBe(finished);
    let done = false;
    void finished.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release.resolve();
    await finished;
    expect(done).toBe(true);
  } finally {
    release.resolve();
    await close();
    warn.mockRestore();
  }
});
