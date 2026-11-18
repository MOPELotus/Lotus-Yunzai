import { expect, test } from "bun:test";
import { scheduledJobs, type Job } from "node-schedule";
import { HandlerScope } from "../lib/plugins/handler.ts";
import { LegacyTasks } from "../lib/plugins/tasks.ts";

const cron = "0 0 * * *";

function app(name: string, fnc: () => unknown, expression = cron) {
  return { name, task: { cron: expression, fnc, log: false } };
}

function jobsSince(baseline: readonly Job[]): Job[] {
  return Object.values(scheduledJobs).filter((job) => !baseline.includes(job));
}

test("任务事务准备时保持不可见，提交按入口去重并撤销旧任务", async () => {
  const tasks = new LegacyTasks();
  const baseline = Object.values(scheduledJobs);
  const calls: string[] = [];
  const old = new HandlerScope();
  const replacement = new HandlerScope();
  const duplicate = new HandlerScope();
  const other = new HandlerScope();

  try {
    tasks.register(old, app("重复任务", () => calls.push("old")));
    tasks.register(old, app("该版本已移除", () => calls.push("removed")));
    tasks.register(other, app("其它入口", () => calls.push("other")));
    const live = jobsSince(baseline);
    const prepared = tasks.prepare([
      { owner: replacement, app: app("重复任务", () => calls.push("replacement")) },
      { owner: duplicate, app: app("重复任务", () => calls.push("duplicate"), "0  0 * *  *") },
      { owner: duplicate, app: app("其它入口", () => calls.push("conflict")) },
      { owner: duplicate, app: app("提交前占用", () => calls.push("displaced")) },
    ], new Set([old]));
    expect(jobsSince(baseline)).toEqual(live);
    expect(calls).toEqual([]);
    tasks.register(other, app("提交前占用", () => calls.push("live-during-prepare")));

    prepared.publish();
    prepared.cancel();
    const visible = jobsSince(baseline);
    expect(visible).toHaveLength(3);
    expect(visible).toContain(live[2]!);
    expect(live[0]!.nextInvocation()).toBeNull();
    expect(live[1]!.nextInvocation()).toBeNull();
    for (const job of live.slice(0, 2)) job.invoke();
    for (const job of visible) job.invoke();
    await Promise.resolve();
    await tasks.stop();
    expect(calls).toEqual(["other", "live-during-prepare", "replacement"]);
    expect(jobsSince(baseline)).toEqual([]);
  } finally {
    await tasks.stop();
  }
});

test("无效 cron 回滚整批准备，取消或停止后的事务不可发布", async () => {
  const tasks = new LegacyTasks();
  const baseline = Object.values(scheduledJobs);
  const owners = [new HandlerScope(), new HandlerScope()] as const;
  const old = app("旧任务", () => {});
  const fresh = app("新任务", () => {});
  try {
    tasks.register(owners[0], old);
    const live = jobsSince(baseline);
    expect(() => tasks.prepare([
      { owner: owners[1], app: fresh },
      { owner: owners[1], app: app("无效任务", () => {}, "70 * * * * *") },
    ], new Set([owners[0]]))).toThrow("cron 无效");
    expect(jobsSince(baseline)).toEqual(live);

    const entries = [{ owner: owners[1], app: fresh }];
    const cancelled = tasks.prepare(entries, new Set([owners[0]]));
    cancelled.cancel();
    cancelled.publish();
    expect(jobsSince(baseline)).toEqual(live);

    const pending = tasks.prepare(entries);
    await tasks.stop();
    pending.publish();
    expect(jobsSince(baseline)).toEqual([]);
  } finally {
    await tasks.stop();
  }
});

test("连续换代不重叠运行同 key，原所有者仍可等待退役任务结束", async () => {
  const tasks = new LegacyTasks();
  const baseline = Object.values(scheduledJobs);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const old = new HandlerScope();
  const middle = new HandlerScope();
  const newest = new HandlerScope();
  const name = "同 key 串行运行";
  try {
    tasks.register(old, app(name, async () => {
      calls.push("old-start");
      started.resolve();
      await release.promise;
      calls.push("old-end");
    }));
    const oldJob = jobsSince(baseline)[0]!;
    oldJob.invoke();
    await started.promise;

    tasks.prepare([{ owner: middle, app: app(name, () => calls.push("middle")) }], new Set([old])).publish();
    const middleJob = jobsSince(baseline)[0]!;
    oldJob.invoke();
    middleJob.invoke();
    tasks.prepare([{ owner: newest, app: app(name, () => calls.push("newest")) }], new Set([middle])).publish();
    const newestJob = jobsSince(baseline)[0]!;
    middleJob.invoke();
    newestJob.invoke();

    let retiredFinished = false;
    const retired = tasks.cancel(new Set([old])).then(() => { retiredFinished = true; });
    await Promise.resolve();
    expect(retiredFinished).toBe(false);
    expect(calls).toEqual(["old-start"]);
    expect(oldJob.nextInvocation()).toBeNull();
    expect(middleJob.nextInvocation()).toBeNull();

    release.resolve();
    await retired;
    newestJob.invoke();
    await Promise.resolve();
    await tasks.cancel(new Set([newest]));
    expect(calls).toEqual(["old-start", "old-end", "newest"]);
  } finally {
    release.resolve();
    await tasks.stop();
  }
});

test("旧 job 排队后的微任务在同步换代后不再调用旧入口", async () => {
  const tasks = new LegacyTasks();
  const baseline = Object.values(scheduledJobs);
  const old = new HandlerScope();
  const replacement = new HandlerScope();
  const calls: string[] = [];
  try {
    tasks.register(old, app("任务切换", () => calls.push("old")));
    const prepared = tasks.prepare([
      { owner: replacement, app: app("任务切换", () => calls.push("replacement")) },
    ], new Set([old]));
    jobsSince(baseline)[0]!.invoke();
    prepared.publish();
    await tasks.cancel(new Set([old]));
    expect(calls).toEqual([]);
    jobsSince(baseline)[0]!.invoke();
    await Promise.resolve();
    await tasks.stop();
    expect(calls).toEqual(["replacement"]);
  } finally {
    await tasks.stop();
  }
});
