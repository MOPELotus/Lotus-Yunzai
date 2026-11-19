import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduledJobs } from "node-schedule";
import { checkinScheduleClock } from "../lib/checkin-schedule-plan.ts";
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
    expect(keys()).toHaveLength(3);
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
