import { expect, test } from 'bun:test';
import { CaptchaError } from '@lotus-yunzai/captcha';
import type { CaptchaRun } from '@lotus-yunzai/hoyo-client';
import { createCaptchaService, type CaptchaFailureReport } from '../lib/captcha/service.ts';
import { createTaskQueue } from '../lib/task-queue.ts';
import { tracePanelCacheTask, type PanelCacheTrace } from '../lib/runtime-trace.ts';

const proof = { captchaVersion: 4 as const, captchaId: 'fixture', lotNumber: 'lot', captchaOutput: 'output', passToken: 'token', genTime: '1234' };
const input = (challenge: () => void = () => {}, signal = new AbortController().signal): CaptchaRun<string> => ({
  signal, verify: async () => {}, allowManual: false,
  async challenge() { challenge(); return { captchaVersion: 4, captchaId: 'fixture' }; },
  async accept() { return { accepted: true, value: 'accepted' }; },
});

test('parallel captcha requests wait before creating fresh challenges and preserve single-worker ownership', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let solves = 0, active = 0, maximum = 0, secondChallenges = 0;
  const service = createCaptchaService({ config: { order: ['local'] }, providers: {
    available: id => id === 'local', async solve() {
      maximum = Math.max(maximum, ++active);
      if (++solves === 1) { entered.resolve(); await release.promise; }
      active--; return proof;
    },
  } });
  try {
    const first = service.run(input()); await entered.promise;
    const second = service.run(input(() => { secondChallenges++; }));
    await Bun.sleep(10);
    expect(secondChallenges).toBe(0); expect(solves).toBe(1);
    release.resolve();
    expect(await first).toEqual({ ok: true, value: 'accepted' });
    expect(await second).toEqual({ ok: true, value: 'accepted' });
    expect(secondChallenges).toBe(1); expect(maximum).toBe(1);
  } finally { release.resolve(); await service.close(); }
});

test('local queue deadline is busy rather than ten failed solver attempts; cancelled waiters never take a slot', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const reports: CaptchaFailureReport[] = [];
  let solves = 0, queuedChallenges = 0;
  const service = createCaptchaService({ config: { order: ['local'], local: { timeout_ms: 30 } }, report: e => reports.push(e), providers: {
    available: id => id === 'local', async solve() { solves++; entered.resolve(); await release.promise; return proof; },
  } });
  const first = service.run(input()); await entered.promise;
  try {
    const controller = new AbortController();
    const cancelled = service.run(input(() => { queuedChallenges++; }, controller.signal));
    controller.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    expect(await service.run(input(() => { queuedChallenges++; }))).toEqual({ ok: false, reason: 'local_busy' });
    expect(solves).toBe(1); expect(queuedChallenges).toBe(0);
    expect(reports).toHaveLength(1); expect(reports[0]).toMatchObject({ stage: 'queue', code: 'captcha_busy', reason: 'local_busy' });
  } finally { release.resolve(); await first; await service.close(); }
});

test('a foreign busy response does not exhaust retries and still permits other automatic providers', async () => {
  for (const fallback of [false, true]) {
    const calls: string[] = [], reports: CaptchaFailureReport[] = [];
    const service = createCaptchaService({ config: { order: ['local', 'ttocr'] }, report: e => reports.push(e), providers: {
      available: id => id === 'local' || fallback && id === 'ttocr', async solve(id) {
        calls.push(id); if (id === 'local') throw new CaptchaError('captcha_busy'); return proof;
      },
    } });
    try {
      expect(await service.run(input())).toEqual(fallback ? { ok: true, value: 'accepted' } : { ok: false, reason: 'local_busy' });
      expect(calls).toEqual(fallback ? ['local', 'ttocr'] : ['local']);
      expect(reports).toHaveLength(1);
    } finally { await service.close(); }
  }
});

test('cancelled FIFO entries do not release the current holder or block later entries', async () => {
  const queue = createTaskQueue(), release = await queue.acquire(), controller = new AbortController();
  const cancelled = queue.acquire(controller.signal);
  controller.abort(new Error('cancelled'));
  await expect(cancelled).rejects.toThrow('cancelled');
  let entered = false;
  const next = queue.acquire().then(release => { entered = true; release(); });
  await Bun.sleep(5); expect(entered).toBe(false);
  release(); await next; expect(entered).toBe(true);
});

test('panel batches serialize startup, coalesce repeated ticks and report partial counts', async () => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const events: PanelCacheTrace[] = []; let secondRuns = 0;
  const first = tracePanelCacheTask('gs-panel-cache', async () => { entered.resolve(); await gate.promise; }, e => events.push(e));
  const second = tracePanelCacheTask('sr-panel-cache', async () => { secondRuns++; return { refreshed: 2, failed: 1, busy: 1, skipped: 3 }; }, e => events.push(e));
  const one = first(); await entered.promise;
  const two = second(); expect(second()).toBe(two);
  await Bun.sleep(5); expect(secondRuns).toBe(0);
  expect(events.filter(e => e.task === 'sr-panel-cache').map(e => e.state)).toEqual(['queued']);
  gate.resolve(); await Promise.all([one, two]);
  expect(events.at(-1)).toMatchObject({ state: 'partial', refreshed: 2, failed: 1, busy: 1, skipped: 3 });
});
