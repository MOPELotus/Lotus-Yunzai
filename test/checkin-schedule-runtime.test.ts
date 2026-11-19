import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduledJobs } from "node-schedule";
import { checkinScheduleClock, generateCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleRuntime } from "../lib/checkin-schedule-runtime.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";

test("旧七段 cron 以中国时区执行，注册时只补计划而不提前跑定制时间", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-clock-"));
  const store = createCheckinScheduleStore(directory);
  const { tomorrow, time, date } = checkinScheduleClock();
  const hour = (Number(time.slice(0, 2)) + 1) % 24;
  const active = { qq: "10001", profileId: 2, enabled: true };
  const known = new Set(Object.keys(scheduledJobs));
  const signal = new AbortController();
  let runs = 0;
  const runtime = createCheckinScheduleRuntime({
    store, signal: signal.signal, config: { fixed_time: "00:00", run_due_cron: `0 17 ${hour} * * ? *`,
      plan_generate_cron: "0 0 0 * * ? *", catch_up_cron: "*/10 * * * *" },
    listProfiles: async () => [active],
    runProfile: async () => { runs++; return { status: "complete", ok: true, stage: "checkin" }; },
  });
  const keys = () => Object.keys(scheduledJobs)
    .filter(name => !known.has(name) && name.startsWith("lotus-checkin-"));
  try {
    runtime.start();
    expect(keys()).toHaveLength(4);
    const due = keys().find(name => name.includes("到期任务"))!;
    const dateOfNextRun = scheduledJobs[due]!.nextInvocation();
    expect(dateOfNextRun).toBeTruthy();
    const next = checkinScheduleClock(new Date(String(dateOfNextRun)));
    expect(next.time).toBe(`${String(hour).padStart(2, "0")}:17`);
    await runtime.addRegisteredProfile(active);
    for (let attempt = 0; attempt < 50 && !await store.read(tomorrow); attempt++) await Bun.sleep(10);
    expect((await store.read(tomorrow))?.entries).toMatchObject([{ qq: "10001", profileId: 2, time: "00:00" }]);
    expect(await store.read(date)).toBeUndefined();
    expect(runs).toBe(0);
  } finally {
    signal.abort();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
  expect(keys()).toEqual([]);
});

test("主人手动生成计划可在关闭自动签到时确认通知，自动入口仍无执行", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-manual-plan-"));
  const store = createCheckinScheduleStore(directory);
  const { tomorrow, date } = checkinScheduleClock();
  const signal = new AbortController();
  const notices: string[] = [];
  const runtime = createCheckinScheduleRuntime({
    store, signal: signal.signal, config: { enable: false, random: { notify_before: false } },
    listProfiles: async () => [{ qq: "10001", profileId: 2, enabled: true }],
    runProfile: async () => { throw new Error("disabled automatic run"); },
    async onNotice(entry, day, late, isCurrent) {
      expect(day).toBe(tomorrow);
      expect(late).toBe(false);
      expect(await isCurrent()).toBe(true);
      expect(entry.noticeAttemptedAt).toBeString();
      notices.push(entry.qq);
      return { status: "confirmed" };
    },
  });
  try {
    runtime.start();
    expect(runtime.runDue()).toBeUndefined();
    const generated = await runtime.generateTomorrow();
    expect(generated?.notices).toMatchObject({ confirmed: 1 });
    expect(notices).toEqual(["10001"]);
    expect((await store.read(tomorrow))?.entries[0]).toMatchObject({ notified: true, time: "04:30" });
    expect(await store.read(date)).toBeUndefined();
  } finally {
    signal.abort();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  expect(await check()).toBe(true);
}

test("固定生成时刻不被启动、补偿或补登提前，热换只替换明日生成任务", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-hot-cron-"));
  const store = createCheckinScheduleStore(directory);
  const signal = new AbortController();
  const known = new Set(Object.keys(scheduledJobs));
  const active = { qq: "10001", profileId: 2, enabled: true };
  let clock = Date.parse("2026-11-19T08:01:29+08:00");
  const { tomorrow } = checkinScheduleClock(clock);
  const initial = { fixed_time: "04:15", plan_generate_cron: "30 1 8 * * ? *",
    run_due_cron: "0 0 4 * * ? *", random: { notify_before: false } };
  let enumerated = 0;
  const runtime = createCheckinScheduleRuntime({
    store, signal: signal.signal, config: initial, now: () => clock,
    listProfiles: async () => { enumerated++; return [active]; },
    runProfile: async () => { throw new Error("unexpected due"); },
  });
  const job = (label: string) => Object.entries(scheduledJobs)
    .find(([name]) => !known.has(name) && name.includes(label))?.[1]!;
  try {
    runtime.start();
    const previous = job("明日计划");
    const due = job("到期任务");
    const catchUp = job("计划补偿");
    expect(checkinScheduleClock(new Date(String(previous.nextInvocation()))).time).toBe("08:01");
    catchUp.invoke();
    await runtime.addRegisteredProfile(active);
    expect(enumerated).toBe(0);
    expect(await store.read(tomorrow)).toBeUndefined();

    const update = { ...initial, fixed_time: "04:45", plan_generate_cron: "0 2 8 * * ? *" };
    runtime.updateConfig(update);
    const current = job("明日计划");
    expect(current).not.toBe(previous);
    expect(job("到期任务")).toBe(due);
    expect(job("计划补偿")).toBe(catchUp);
    expect(checkinScheduleClock(new Date(String(current.nextInvocation()))).time).toBe("08:02");
    clock = Date.parse("2026-11-19T08:01:30+08:00");
    previous.invoke();
    catchUp.invoke();
    await runtime.addRegisteredProfile(active);
    expect(enumerated).toBe(0);

    clock = Date.parse("2026-11-19T08:02:00+08:00");
    catchUp.invoke();
    await until(async () => (await store.read(tomorrow))?.entries[0]?.time === "04:45");
    const previousPlan = await store.read(tomorrow);
    runtime.updateConfig({ ...update, fixed_time: "05:05" });
    expect(job("明日计划")).toBe(current);
    catchUp.invoke();
    await Bun.sleep(20);
    expect(await store.read(tomorrow)).toEqual(previousPlan);
    current.invoke();
    await until(async () => (await store.read(tomorrow))?.entries[0]?.time === "05:05");
    expect((await store.read(tomorrow))?.generatedAt).toBe(previousPlan?.generatedAt);
  } finally {
    signal.abort();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("今日运行期间保留已捕获的配置，后续对账使用新配置且保留已完成槽位", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-hot-tick-"));
  const store = createCheckinScheduleStore(directory);
  const signal = new AbortController();
  const clock = Date.parse("2026-11-19T08:00:00+08:00");
  const { date } = checkinScheduleClock(clock);
  const one = { qq: "10001", profileId: 2, enabled: true };
  const two = { qq: "10002", profileId: 2, enabled: true };
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const ran: string[] = [];
  const runtime = createCheckinScheduleRuntime({
    store, signal: signal.signal, config: { fixed_time: "04:15" }, now: () => clock,
    listProfiles: async () => {
      if (calls++ > 0) return [one, two];
      await gate.promise;
      return [one];
    },
    runProfile: async entry => { ran.push(`${entry.qq}/${entry.time}`); return { status: "complete", ok: true, stage: "checkin" }; },
  });
  try {
    const first = runtime.runDue();
    expect(calls).toBe(1);
    const next = { fixed_time: "04:45" };
    runtime.updateConfig(next);
    next.fixed_time = "04:55";
    expect(await store.read(date)).toBeUndefined();
    gate.resolve();
    expect(await first).toMatchObject({ completed: 1 });
    expect(await runtime.runDue()).toMatchObject({ completed: 1 });
    expect(ran).toEqual(["10001/04:15", "10002/04:45"]);
    expect((await store.read(date))?.entries).toMatchObject([
      { qq: "10001", done: true, time: "04:15" }, { qq: "10002", done: true, time: "04:45" },
    ]);
  } finally {
    gate.resolve();
    signal.abort();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("复杂 cron 仍交给中国时区 Job，自动补偿不猜测应触发的日期", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-hot-arbitrary-"));
  const store = createCheckinScheduleStore(directory);
  const signal = new AbortController();
  const clock = Date.parse("2026-11-19T08:00:00+08:00");
  const { tomorrow } = checkinScheduleClock(clock);
  const known = new Set(Object.keys(scheduledJobs));
  const active = { qq: "10001", profileId: 2, enabled: true };
  let calls = 0;
  const runtime = createCheckinScheduleRuntime({
    store, signal: signal.signal, config: { plan_generate_cron: "0 17 9 * * 1,3", run_due_cron: "15 9 * * *" },
    now: () => clock, listProfiles: async () => { calls++; return [active]; },
    runProfile: async () => { throw new Error("unexpected due"); },
  });
  const job = (label: string) => Object.entries(scheduledJobs)
    .find(([name]) => !known.has(name) && name.includes(label))?.[1]!;
  try {
    runtime.start();
    const planned = job("明日计划");
    const next = checkinScheduleClock(new Date(String(planned.nextInvocation())));
    expect(next.time).toBe("09:17");
    expect([1, 3]).toContain(new Date(`${next.date}T00:00Z`).getUTCDay());
    job("计划补偿").invoke();
    await runtime.addRegisteredProfile(active);
    expect(calls).toBe(0);
    expect(await store.read(tomorrow)).toBeUndefined();

    planned.invoke();
    await until(async () => (await store.read(tomorrow))?.entries[0]?.qq === "10001");
    expect(calls).toBe(1);
  } finally {
    signal.abort();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("两次日末任务只补跑当天可核对的社区，不启动普通签到", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-community-final-"));
  const store = createCheckinScheduleStore(directory);
  const signal = new AbortController();
  const known = new Set(Object.keys(scheduledJobs));
  const at = Date.parse("2026-11-19T23:50:00+08:00");
  const { date } = checkinScheduleClock(at);
  const profiles = [{ qq: "10001", profileId: 2, enabled: true }, { qq: "10002", profileId: 2, enabled: true }];
  const config = { fixed_time: "09:00", plan_generate_cron: "0 17 9 * * 1,3", run_due_cron: "15 9 * * *" };
  const plan = generateCheckinSchedulePlan({ config, profiles, now: at, date });
  const accountKey = "a".repeat(64);
  const ready = { forums: ["6"], attempts: 2, nextAt: new Date(at).toISOString(), accountKey, verifiedUnsent: true } as const;
  const calls: string[] = [];
  const runtime = createCheckinScheduleRuntime({
    store, config, signal: signal.signal, now: () => at,
    listProfiles: async () => profiles,
    async runProfile(entry, context) {
      calls.push(entry.qq);
      expect(context.communityAccountKey).toBe(accountKey);
      expect(context.communityRetryForums).toEqual(["6"]);
      return { status: "complete", ok: true, stage: "checkin" };
    },
  });
  try {
    await store.update(date, () => ({
      plan: { ...plan, entries: plan.entries.map(entry => entry.qq === "10001" ? { ...entry, communityRetry: ready } : entry) },
      result: undefined,
    }));
    runtime.start();
    const final = Object.entries(scheduledJobs).find(([name]) => !known.has(name) && name.includes("社区补跑"))?.[1]!;
    expect(["23:50", "23:59"]).toContain(checkinScheduleClock(new Date(String(final.nextInvocation()))).time);
    final.invoke();
    await until(async () => (await store.read(date))?.entries.some(entry => entry.qq === "10001" && entry.done) === true);
    expect(calls).toEqual(["10001"]);
    expect((await store.read(date))?.entries.find(entry => entry.qq === "10002")?.done).toBe(false);
  } finally {
    signal.abort();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
