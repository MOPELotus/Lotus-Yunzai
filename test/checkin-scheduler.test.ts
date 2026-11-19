import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCheckinSchedulePlan, type CheckinScheduleProfile } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { createCheckinScheduler } from "../lib/checkin-scheduler.ts";

const date = "2026-11-19";
const dueAt = Date.parse("2026-11-19T07:00:00+08:00");
const config = { fixed_time: "06:00" };
const first = { qq: "1001", profileId: 1, enabled: true };
const successful = { status: "complete", stage: "checkin", ok: true } as const;

async function withStore(run: (store: ReturnType<typeof createCheckinScheduleStore>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-scheduler-"));
  try {
    await run(createCheckinScheduleStore(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("只跑中国当天到期的启用档案，保留旧社区补跑计划，确认后才递送回执", async () => {
  await withStore(async (store, directory) => {
    const profiles: CheckinScheduleProfile[] = [
      first, { qq: "1002", enabled: false },
      { qq: "1003", enabled: true, schedule: { mode: "fixed", fixedTime: "08:00" } },
      { qq: "1004", enabled: true }, { qq: "1005", enabled: true },
    ];
    const retry = { forums: ["2"], attempts: 2, nextAt: "2026-11-19T06:30:00+08:00" };
    const older = generateCheckinSchedulePlan({
      date, profiles: profiles.map(profile => ({ ...profile, enabled: true })), config, now: dueAt,
    });
    await store.update(date, () => ({
      plan: { ...older, entries: older.entries.map(entry => ["1002", "1004"].includes(entry.qq)
        ? { ...entry, communityRetry: retry, runningAt: "2026-11-19T06:45:00+08:00" } : entry) },
      result: null,
    }));
    const trace: string[] = [];
    const reply = "内存回执";
    const outcome = { ...successful, reply, message: "任意上游原文" };
    const scheduler = createCheckinScheduler({
      store, config, now: () => dueAt, listProfiles: async () => profiles,
      async runProfile(entry, context) {
        context.verifyDay();
        expect(context.date).toBe(date);
        expect((await store.read(date))?.entries.find(item => item.qq === entry.qq)?.runningAt).toBe(entry.runningAt);
        trace.push(`run ${entry.qq}`);
        return outcome;
      },
      async onComplete(entry, result) {
        expect((await store.read(date))?.entries.find(item => item.qq === entry.qq)?.done).toBe(true);
        expect(result.reply).toBe(reply);
        trace.push(`notify ${entry.qq}`);
        throw new Error("通知失败");
      },
    });
    expect(await scheduler.tick()).toEqual({ date, status: "complete", completed: 2, deferred: 0 });
    expect(trace).toEqual(["run 1001", "notify 1001", "run 1005", "notify 1005"]);
    expect((await store.read(date))?.entries.filter(entry => entry.communityRetry)).toMatchObject([
      { qq: "1002", communityRetry: retry }, { qq: "1004", communityRetry: retry },
    ]);
    const saved = await readFile(join(directory, `${date}.json`), "utf8");
    expect(saved).not.toContain(reply);
    expect(saved).not.toContain(outcome.message);
    expect(saved).toContain("自动签到已完成。");
    expect(await scheduler.tick()).toEqual({ date, status: "complete", completed: 0, deferred: 0 });
  });
});

test("第二个实例遇到日期执行锁不会清除运行标记，繁忙档案只在下次调度重试", async () => {
  await withStore(async (store, directory) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondStore = createCheckinScheduleStore(directory);
    const scheduler = createCheckinScheduler({
      store, config, now: () => dueAt, listProfiles: async () => [first],
      async runProfile() {
        entered.resolve();
        await release.promise;
        return { status: "busy" };
      },
    });
    let attempts = 0;
    const secondScheduler = createCheckinScheduler({
      store: secondStore, config, now: () => dueAt, listProfiles: async () => [first],
      async runProfile() { attempts++; return successful; },
    });
    const run = scheduler.tick();
    try {
      await entered.promise;
      const running = (await secondStore.read(date))?.entries[0]?.runningAt;
      expect(running).toBeTruthy();
      expect(await secondScheduler.tick()).toEqual({ date, status: "locked", completed: 0, deferred: 0 });
      expect((await secondStore.read(date))?.entries[0]?.runningAt).toBe(running);
    } finally {
      release.resolve();
      expect(await run).toEqual({ date, status: "complete", completed: 0, deferred: 1 });
    }
    expect(attempts).toBe(0);
    expect((await secondStore.read(date))?.entries[0]).toMatchObject({ done: false });
    expect((await secondStore.read(date))?.entries[0]?.runningAt).toBeUndefined();
    expect(await secondScheduler.tick()).toEqual({ date, status: "complete", completed: 1, deferred: 0 });
    expect(attempts).toBe(1);
  });
});

test("停机保留不可确认的运行标记，恢复时再用当前设置核对同日档案", async () => {
  await withStore(async store => {
    const stop = new AbortController();
    let enabled = true;
    let calls = 0;
    let notifications = 0;
    const scheduler = createCheckinScheduler({
      store, config, now: () => dueAt, listProfiles: async () => [{ ...first, enabled }],
      async runProfile() {
        calls++;
        stop.abort();
        return successful;
      },
      onComplete() { notifications++; },
    });
    expect(await scheduler.tick(stop.signal)).toEqual({ date, status: "interrupted", completed: 0, deferred: 0 });
    expect((await store.read(date))?.entries[0]).toMatchObject({ runningAt: "2026-11-19T07:00:00.000+08:00", done: false });
    enabled = false;
    expect(await scheduler.tick()).toEqual({ date, status: "complete", completed: 0, deferred: 0 });
    expect((await store.read(date))?.entries).toEqual([]);
    expect(calls).toBe(1);
    expect(notifications).toBe(0);
  });
});

test("未知运行结果保留同日 claim，重启后靠业务读回确认而不重复提交", async () => {
  await withStore(async (store, directory) => {
    let remoteSigned = false;
    let writes = 0;
    const scheduler = createCheckinScheduler({
      store, config, now: () => dueAt, listProfiles: async () => [first],
      async runProfile() {
        remoteSigned = true;
        writes++;
        throw new Error("回执丢失");
      },
    });
    expect(await scheduler.tick()).toEqual({ date, status: "interrupted", completed: 0, deferred: 0 });
    expect((await store.read(date))?.entries[0]?.runningAt).toBeTruthy();
    const resumed = createCheckinScheduler({
      store: createCheckinScheduleStore(directory), config, now: () => dueAt + 60_000,
      listProfiles: async () => [first],
      async runProfile(entry) {
        expect(entry.runningAt).toBe("2026-11-19T07:01:00.000+08:00");
        expect(remoteSigned).toBe(true);
        if (!remoteSigned) writes++;
        return successful;
      },
    });
    expect(await resumed.tick()).toEqual({ date, status: "complete", completed: 1, deferred: 0 });
    expect(writes).toBe(1);
    const entry = (await store.read(date))?.entries[0];
    expect(entry?.runningAt).toBeUndefined();
    expect(entry?.doneAt).toBe("2026-11-19T07:01:00.000+08:00");
  });
});

test("跨日停止旧日期执行并保留原 claim，次日按新计划运行", async () => {
  await withStore(async store => {
    const next = "2026-11-20";
    let now = Date.parse(`${date}T23:58:00+08:00`);
    const invoked: string[] = [];
    const scheduler = createCheckinScheduler({
      store, config: { fixed_time: "00:00" }, now: () => now, listProfiles: async () => [first, { ...first, qq: "1002" }],
      async runProfile(entry, context) {
        invoked.push(`${context.date} ${entry.qq}`);
        if (context.date === date) now = Date.parse(`${next}T00:01:00+08:00`);
        context.verifyDay();
        return successful;
      },
    });
    expect(await scheduler.tick()).toEqual({ date, status: "interrupted", completed: 0, deferred: 0 });
    const yesterday = await store.read(date);
    expect(yesterday?.entries[0]?.runningAt).toBe("2026-11-19T23:58:00.000+08:00");
    expect(yesterday?.entries[0]?.done).toBe(false);
    expect(await scheduler.tick()).toEqual({ date: next, status: "complete", completed: 2, deferred: 0 });
    expect(await store.read(date)).toEqual(yesterday);
    expect(invoked).toEqual([`${date} 1001`, `${next} 1001`, `${next} 1002`]);
  });
});
