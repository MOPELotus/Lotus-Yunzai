import { expect, test } from "bun:test";
import { scheduledJobs } from "node-schedule";
import { createUpdateNotices } from "../lib/update-notice.ts";

test("宿主更新前中止候选检查，遇到未知通知回执不向同一 SHA 重发", async () => {
  const originalJobs = new Set(Object.keys(scheduledJobs));
  const lifecycle = new AbortController();
  const started = Promise.withResolvers<void>();
  const firstSend = Promise.withResolvers<void>();
  let accepting = true, reads = 0, sends = 0;
  const notices = createUpdateNotices({
    signal: lifecycle.signal, accepting: () => accepting,
    async read(signal) {
      if (++reads === 1) {
        started.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        expect(signal.aborted).toBe(true);
      }
      return { branch: "main", current: "a".repeat(40), candidate: "b".repeat(40), behind: 1, ahead: 0, dirty: false };
    },
    async send() {
      sends++;
      firstSend.resolve();
      return "unknown";
    },
  });
  try {
    notices.apply({ update_notice: true, update_notice_cron: "0 0 0 1 1 *" });
    const job = Object.values(scheduledJobs).find(job => !originalJobs.has(job.name))!;
    job.invoke();
    await started.promise;
    accepting = false;
    await notices.interrupt();
    job.invoke();
    expect(reads).toBe(1);
    expect(sends).toBe(0);

    accepting = true;
    await Bun.sleep(0);
    job.invoke();
    await firstSend.promise;
    await Bun.sleep(0);
    job.invoke();
    await Bun.sleep(0);
    expect(reads).toBe(3);
    expect(sends).toBe(1);

    lifecycle.abort();
    await notices.stop();
    job.invoke();
    expect(reads).toBe(3);
  } finally {
    lifecycle.abort();
    await notices.stop();
  }
});
