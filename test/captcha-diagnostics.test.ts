import { expect, test } from 'bun:test';
import { CaptchaError } from '@lotus-yunzai/captcha';
import { createCaptchaService, type CaptchaFailureReport } from '../lib/captcha/service.ts';
import { runtimeTraceId, tracePanelCacheTask } from '../lib/runtime-trace.ts';

const secret = 'private-cookie-token-challenge-link';
const challenge = { captchaVersion: 4 as const, captchaId: secret };
const input = () => ({ signal: new AbortController().signal, verify: async () => {},
  challenge: async () => challenge, accept: async () => { throw Error('must not submit'); } });

for (const code of ['recognition_failed', 'local_worker_failed', 'local_worker_exited', 'timeout']) {
  test(`captcha diagnostics distinguish ${code} without logging payloads or changing retries`, async () => {
    const reports: CaptchaFailureReport[] = [];
    const service = createCaptchaService({ config: { order: ['local'] }, report: entry => reports.push(entry),
      providers: { available: id => id === 'local', async solve() { throw new CaptchaError(code, secret); } } });
    expect(await service.run(input())).toEqual({ ok: false, reason: 'provider_request_failed' });
    expect(reports).toHaveLength(10);
    expect(reports.every(entry => entry.code === code && entry.stage === 'solve')).toBe(true);
    expect(new Set(reports.map(entry => entry.runId)).size).toBe(1);
    expect(reports.map(entry => [entry.round, entry.attempt])).toEqual([1,2].flatMap(round => [1,2,3,4,5].map(attempt => [round,attempt])));
    expect(JSON.stringify(reports)).not.toContain(secret);
    await service.close();
  });
}

test('unknown errors and non-whitelisted local codes cannot leak arbitrary strings', async () => {
  for (const error of [new Error(secret), new CaptchaError(secret, secret), { code: 'local_worker_failed', message: secret }]) {
    const reports: CaptchaFailureReport[] = [];
    const service = createCaptchaService({ config: { order: ['local'] }, report: entry => reports.push(entry),
      providers: { available: id => id === 'local', async solve() { throw error; } } });
    await service.run(input());
    expect(reports.every(entry => entry.code === undefined)).toBe(true);
    expect(JSON.stringify(reports)).not.toContain(secret);
    await service.close();
  }
});

test('parallel refresh tasks correlate captcha attempts without mixing task or run IDs', async () => {
  const reports: CaptchaFailureReport[] = [];
  const events: { taskId: string; state: string }[] = [];
  const service = createCaptchaService({ config: { order: ['local'] }, report: entry => reports.push(entry),
    providers: { available: id => id === 'local', async solve() { await Promise.resolve(); throw new CaptchaError('timeout'); } } });
  const seen: string[] = [];
  const run = () => tracePanelCacheTask('sr-panel-cache', async () => {
    const before = runtimeTraceId();
    await service.run(input());
    expect(runtimeTraceId()).toBe(before);
    seen.push(before!);
  }, entry => events.push(entry))();
  await Promise.all([run(), run()]);
  expect(new Set(seen).size).toBe(2);
  expect(new Set(reports.map(entry => entry.taskId))).toEqual(new Set(seen));
  expect(new Set(reports.map(entry => entry.runId)).size).toBe(2);
  expect(events.filter(entry => entry.state === 'started')).toHaveLength(2);
  expect(events.filter(entry => entry.state === 'finished')).toHaveLength(2);
  expect(runtimeTraceId()).toBeUndefined();
  await service.close();
});

test('task failure preserves original exception and clears async context', async () => {
  const error = new Error(secret), states: string[] = [];
  await expect(tracePanelCacheTask('gs-panel-cache', async () => { throw error; }, entry => states.push(entry.state))()).rejects.toBe(error);
  expect(states).toEqual(['started', 'failed']);
  expect(runtimeTraceId()).toBeUndefined();
});
