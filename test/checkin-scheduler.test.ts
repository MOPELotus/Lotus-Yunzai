import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCheckinSchedulePlan, type CheckinScheduleProfile } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { createCheckinScheduler } from "../lib/checkin-scheduler.ts";

const date = "2026-11-19";
const dueAt = Date.parse("2026-11-19T07:00:00+08:00");
const config = { mode: "fixed" as const, fixed_time: "06:00" };
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

test("迁回两处旧计划后，只执行未领取的档案，已完成和在途记录跨重启保留", async () => {
  await withStore(async (_unused, directory) => {
    const profiles = [first, { ...first, profileId: 2 }, { ...first, profileId: 3 }];
    const plan = generateCheckinSchedulePlan({ date, profiles, config, now: dueAt });
    const primary = join(directory, "current");
    const sources = ["Lotus-Plugin", "Lotus-ReFactor"].map(id => ({ id, directory: join(directory, id) }));
    const runningAt = "2026-11-19T06:10:00+08:00";
    const legacy = [JSON.stringify({ ...plan, entries: [{ ...plan.entries[0], done: true, notified: true }] }) + "\r\n",
      JSON.stringify({ ...plan, entries: [{ ...plan.entries[1], runningAt }] }) + "\n"];
    await Promise.all(sources.map(async (source, index) => {
      await mkdir(source.directory, { recursive: true });
      await writeFile(join(source.directory, date + ".json"), legacy[index]!);
    }));
    const fresh = createCheckinScheduleStore(primary, sources);
    expect((await fresh.read(date))?.entries).toEqual([
      expect.objectContaining({ profileId: 1, done: true, notified: true }),
      expect.objectContaining({ profileId: 2, runningAt, done: true, stage: "legacy-unconfirmed" }),
    ]);
    expect(await Bun.file(join(primary, date + ".json")).exists()).toBe(false);
    await createCheckinScheduleStore(primary).update(date, () => ({ plan, result: undefined }));
    const ran: number[] = [];
    const scheduler = (store: typeof fresh) => createCheckinScheduler({ store, config, now: () => dueAt,
      listProfiles: async () => profiles, async runProfile(entry) {
        ran.push(entry.profileId);
        return successful;
      } });
    expect(await scheduler(fresh).tick()).toMatchObject({ status: "complete", completed: 1 });
    expect(ran).toEqual([3]);
    const current = await readFile(join(primary, date + ".json"), "utf8");
    expect(JSON.parse(current)).toMatchObject({ importedLegacy: sources.map(source => source.id) });
    expect(await Promise.all(sources.map(source => readFile(join(source.directory, date + ".json"), "utf8")))).toEqual(legacy);
    expect(await scheduler(createCheckinScheduleStore(primary, sources)).tick()).toMatchObject({ status: "complete", completed: 0 });
    expect(await readFile(join(primary, date + ".json"), "utf8")).toBe(current);

    const downgraded = JSON.parse(current);
    delete downgraded.importedLegacy;
    delete downgraded.entries.find((record: { profileId: number }) => record.profileId === 2).runningAt;
    await writeFile(join(primary, date + ".json"), JSON.stringify(downgraded));
    const reupgraded = createCheckinScheduleStore(primary, sources);
    expect(await scheduler(reupgraded).tick()).toMatchObject({ status: "complete", completed: 0 });
    expect((await reupgraded.read(date))?.entries[1]).toMatchObject({ stage: "legacy-unconfirmed", runningAt, done: true });
    expect(ran).toEqual([3]);
  });
});

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
    expect(await scheduler.tick()).toMatchObject({ date, status: "complete", completed: 2, deferred: 0 });
    expect(trace).toEqual(["run 1001", "notify 1001", "run 1005", "notify 1005"]);
    expect((await store.read(date))?.entries.filter(entry => entry.communityRetry)).toMatchObject([
      { qq: "1002", communityRetry: retry }, { qq: "1004", communityRetry: retry },
    ]);
    const saved = await readFile(join(directory, `${date}.json`), "utf8");
    expect(saved).not.toContain(reply);
    expect(saved).not.toContain(outcome.message);
    expect(saved).toContain("自动签到已完成。");
    expect(await scheduler.tick()).toMatchObject({ date, status: "complete", completed: 0, deferred: 0 });
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
      expect(await secondScheduler.tick()).toMatchObject({ date, status: "locked", completed: 0, deferred: 0 });
      expect((await secondStore.read(date))?.entries[0]?.runningAt).toBe(running);
    } finally {
      release.resolve();
      expect(await run).toMatchObject({ date, status: "complete", completed: 0, deferred: 1 });
    }
    expect(attempts).toBe(0);
    expect((await secondStore.read(date))?.entries[0]).toMatchObject({ done: false });
    expect((await secondStore.read(date))?.entries[0]?.runningAt).toBeUndefined();
    expect(await secondScheduler.tick()).toMatchObject({ date, status: "complete", completed: 1, deferred: 0 });
    expect(attempts).toBe(1);
  });
});

test("社区签到提交前记录写入意图，重启保留已受理和未确认的分区", async () => {
  await withStore(async (store, directory) => {
    const setup = { store, config, now: () => dueAt, listProfiles: async () => [first] };
    const interrupted = createCheckinScheduler({
      ...setup,
      async runProfile(_entry, { communityWrites }) {
        expect(communityWrites?.previous).toEqual({});
        await communityWrites?.start("2");
        expect((await store.read(date))?.entries[0]?.communityWrites).toEqual({ 2: "pending" });
        await communityWrites?.settle("2", "accepted");
        await communityWrites?.start("6");
        throw new Error("模拟发出第二次请求后中止");
      },
    });
    expect(await interrupted.tick()).toMatchObject({ status: "interrupted", completed: 0 });
    const restored = createCheckinScheduleStore(directory);
    const resumed = createCheckinScheduler({
      ...setup, store: restored,
      async runProfile(entry, { communityWrites }) {
        expect(entry.communityWrites).toEqual({ 2: "accepted", 6: "pending" });
        expect(communityWrites?.previous).toEqual(entry.communityWrites);
        await expect(communityWrites?.start("6")).rejects.toThrow("无法确认社区签到提交记录已保存");
        return { ...successful, ok: false };
      },
    });
    expect(await resumed.tick()).toMatchObject({ status: "complete", completed: 1 });
    expect((await restored.read(date))?.entries[0]).toMatchObject({
      done: true, ok: false, communityWrites: { 2: "accepted", 6: "pending" },
    });
    expect(await resumed.tick()).toMatchObject({ status: "complete", completed: 0 });
  });
});

test("只补跑有未提交证据的分区，限流档案按旧间隔与收尾时刻推进", async () => {
  await withStore(async store => {
    const accountKey = "a".repeat(64);
    let at = dueAt;
    const another = { qq: "2002", profileId: 1, enabled: true, schedule: { mode: "fixed", fixedTime: "08:30" } } as const;
    const retryOnly = { communityRetriesOnly: true };
    const runner = createCheckinScheduler({
      store, config, now: () => at, listProfiles: async () => [first, another],
      async runProfile(entry, context) {
        expect(entry.qq).toBe(first.qq);
        const journal = context.communityWrites!;
        if (!context.communityRetryForums) {
          await journal.start("2", accountKey);
          await journal.settle("2", "accepted");
        } else {
          expect(context.communityRetryForums).toEqual(["6", "8"]);
          expect(context.communityAccountKey).toBe(accountKey);
          expect(journal.previous).toEqual({ 2: "accepted", 6: "retryable" });
        }
        await journal.start("6", accountKey);
        await journal.settle("6", "retryable");
        return { ...successful, ok: false, retryCommunity: { forums: ["6", "8"], otherFailure: false, accountKey } };
      },
    });
    expect(await runner.tick()).toMatchObject({ completed: 0, deferred: 1 });
    const get = async () => (await store.read(date))?.entries.find(entry => entry.qq === first.qq);
    const retry = { forums: ["6", "8"], verifiedUnsent: true, accountKey, otherFailure: false } as const;
    expect((await get())?.communityRetry).toEqual({ ...retry, attempts: 0, nextAt: "2026-11-18T23:10:00.000Z" });
    at += 9 * 60_000;
    expect(await runner.tick(undefined, retryOnly)).toMatchObject({ completed: 0, deferred: 0 });
    at += 60_000;
    expect(await runner.tick(undefined, retryOnly)).toMatchObject({ completed: 0, deferred: 1 });
    expect((await get())?.communityRetry).toEqual({ ...retry, attempts: 1, nextAt: "2026-11-19T00:10:00.000Z" });
    at = Date.parse(`${date}T23:50:00+08:00`);
    expect(await runner.tick(undefined, retryOnly)).toMatchObject({ completed: 1, deferred: 0 });
    expect(await get()).toMatchObject({ done: true, ok: false, communityWrites: { 2: "accepted", 6: "retryable" } });
    expect((await get())?.communityRetry).toBeUndefined();
    expect((await store.read(date))?.entries.find(entry => entry.qq === another.qq)).toMatchObject({ done: false });
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
    expect(await scheduler.tick(stop.signal)).toMatchObject({ date, status: "interrupted", completed: 0, deferred: 0 });
    expect((await store.read(date))?.entries[0]).toMatchObject({ runningAt: "2026-11-19T07:00:00.000+08:00", done: false });
    enabled = false;
    expect(await scheduler.tick()).toMatchObject({ date, status: "complete", completed: 0, deferred: 0 });
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
    expect(await scheduler.tick()).toMatchObject({ date, status: "interrupted", completed: 0, deferred: 0 });
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
    expect(await resumed.tick()).toMatchObject({ date, status: "complete", completed: 1, deferred: 0 });
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
      store, config: { mode: "fixed" as const, fixed_time: "00:00" }, now: () => now, listProfiles: async () => [first, { ...first, qq: "1002" }],
      async runProfile(entry, context) {
        invoked.push(`${context.date} ${entry.qq}`);
        if (context.date === date) now = Date.parse(`${next}T00:01:00+08:00`);
        context.verifyDay();
        return successful;
      },
    });
    expect(await scheduler.tick()).toMatchObject({ date, status: "interrupted", completed: 0, deferred: 0 });
    const yesterday = await store.read(date);
    expect(yesterday?.entries[0]?.runningAt).toBe("2026-11-19T23:58:00.000+08:00");
    expect(yesterday?.entries[0]?.done).toBe(false);
    expect(await scheduler.tick()).toMatchObject({ date: next, status: "complete", completed: 2, deferred: 0 });
    expect(await store.read(date)).toEqual(yesterday);
    expect(invoked).toEqual([`${date} 1001`, `${next} 1001`, `${next} 1002`]);
  });
});
