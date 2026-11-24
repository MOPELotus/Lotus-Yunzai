import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyCheckinPlan } from "../lib/checkin-plan-notice.ts";
import { generateCheckinSchedulePlan, reconcileCheckinSchedulePlan, type CheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";

const date = "2026-11-20";
const now = Date.parse("2026-11-19T07:00:00+08:00");
const confirmed = { status: "confirmed" } as const;

async function withPlan(
  users: readonly string[],
  run: (store: ReturnType<typeof createCheckinScheduleStore>, plan: CheckinSchedulePlan, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-plan-notice-"));
  try {
    const store = createCheckinScheduleStore(directory);
    const plan = generateCheckinSchedulePlan({ date, now, config: { mode: "fixed" }, profiles: users.map(qq => ({ qq, enabled: true })) });
    await store.update(date, () => ({ plan, result: undefined }));
    await run(store, plan, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("原子领取时保留旧通知状态，其他实例在确认前后均不重复发送", async () => {
  await withPlan(["51", "52"], async (store, plan, directory) => {
    await store.update(date, () => ({
      plan: { ...plan, entries: [{ ...plan.entries[0]!, notified: true }, plan.entries[1]!] },
      result: undefined,
    }));
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const second = createCheckinScheduleStore(directory);
    const sent: string[] = [];
    const first = notifyCheckinPlan(store, plan, async (entry, when) => {
      expect(when).toBe(date);
      sent.push(entry.qq);
      started.resolve();
      await proceed.promise;
      return confirmed;
    });
    try {
      await started.promise;
      const active = (await second.read(date))?.entries[1];
      expect(active?.notified).toBe(false);
      expect(active?.noticeAttemptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(await notifyCheckinPlan(second, plan, async entry => {
        sent.push(entry.qq);
        return confirmed;
      })).toEqual({ confirmed: 0, unknown: 0, unavailable: 0, skipped: 2 });
    } finally {
      proceed.resolve();
      expect(await first).toEqual({ confirmed: 1, unknown: 0, unavailable: 0, skipped: 1 });
    }
    expect((await second.read(date))?.entries.map(({ notified, noticeAttemptedAt }) => [notified, noticeAttemptedAt]))
      .toEqual([[true, undefined], [true, undefined]]);
    expect(await notifyCheckinPlan(second, plan, async entry => {
      sent.push(entry.qq);
      return confirmed;
    })).toEqual({ confirmed: 0, unknown: 0, unavailable: 0, skipped: 2 });
    expect(sent).toEqual(["52"]);
  });
});

test("明确未发释放领取，未知和发送异常保存领取且重启不再发", async () => {
  await withPlan(["51", "52", "53", "54"], async (store, plan, directory) => {
    expect(await notifyCheckinPlan(store, plan, async entry => {
      if (entry.qq === "51") return { status: "unavailable" };
      if (entry.qq === "52") return { status: "skipped" };
      if (entry.qq === "53") return { status: "unknown" };
      throw new Error("隐藏的上游回执");
    })).toEqual({ confirmed: 0, unknown: 2, unavailable: 1, skipped: 1 });
    const stored = await readFile(join(directory, `${date}.json`), "utf8");
    expect(stored).not.toContain("隐藏的上游回执");
    const rebooted = createCheckinScheduleStore(directory);
    const traced: string[] = [];
    const checked = await rebooted.update(date, current => {
      const reconciled = reconcileCheckinSchedulePlan(current!, {
        config: { mode: "fixed" }, now, profiles: ["51", "52", "53", "54"].map(qq => ({ qq, enabled: true })),
      });
      return { plan: reconciled, result: reconciled };
    });
    expect(checked.entries.filter(entry => entry.noticeAttemptedAt).map(entry => entry.qq)).toEqual(["53", "54"]);
    expect(await notifyCheckinPlan(rebooted, checked, async entry => {
      traced.push(entry.qq);
      return confirmed;
    })).toEqual({ confirmed: 2, unknown: 0, unavailable: 0, skipped: 2 });
    expect(traced).toEqual(["51", "52"]);
  });
});

test("发送前替换日期代际或时段不会领取，迟到确认不会写入改动后的时段", async () => {
  await withPlan(["51", "52"], async (store, plan) => {
    const replace = async (old: CheckinSchedulePlan) => {
      const next = { ...old, entries: old.entries.map(entry => ({ ...entry, time: "04:31", noticeAttemptedAt: undefined, notified: false })) };
      await store.update(date, () => ({ plan: next, result: undefined }));
      return next;
    };
    const current = await replace(plan);
    expect(await notifyCheckinPlan(store, plan, async () => confirmed))
      .toEqual({ confirmed: 0, unknown: 0, unavailable: 0, skipped: 2 });
    const previousGeneration = { ...current, generatedAt: "2026-11-18T10:00:00+08:00" };
    expect(await notifyCheckinPlan(store, previousGeneration, async () => confirmed))
      .toEqual({ confirmed: 0, unknown: 0, unavailable: 0, skipped: 2 });
    const sent: string[] = [];
    expect(await notifyCheckinPlan(store, current, async entry => {
      sent.push(entry.qq);
      await store.update(date, old => ({
        plan: old && { ...old, entries: old.entries.map(item => ({ ...item, mode: "random", noticeAttemptedAt: undefined })) },
        result: undefined,
      }));
      return confirmed;
    })).toEqual({ confirmed: 1, unknown: 0, unavailable: 0, skipped: 1 });
    expect(sent).toEqual(["51"]);
    expect((await store.read(date))?.entries.map(entry => [entry.mode, entry.notified, entry.noticeAttemptedAt]))
      .toEqual([["random", false, undefined], ["random", false, undefined]]);
  });
});

test("领取后中断保留状态，并停止处理剩余档案", async () => {
  await withPlan(["51", "52"], async (store, plan) => {
    const controller = new AbortController();
    const sent: string[] = [];
    expect(await notifyCheckinPlan(store, plan, async entry => {
      sent.push(entry.qq);
      controller.abort();
      return { status: "skipped" };
    }, controller.signal)).toEqual({ confirmed: 0, unknown: 1, unavailable: 0, skipped: 0 });
    const saved = (await store.read(date))!;
    expect(saved.entries.map(entry => [entry.notified, Boolean(entry.noticeAttemptedAt)]))
      .toEqual([[false, true], [false, false]]);
    expect(await notifyCheckinPlan(store, saved, async entry => {
      sent.push(entry.qq);
      return confirmed;
    })).toEqual({ confirmed: 1, unknown: 0, unavailable: 0, skipped: 1 });
    expect(sent).toEqual(["51", "52"]);
  });
});
