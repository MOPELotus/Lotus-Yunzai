import { expect, test } from "bun:test";
import { scheduledJobs } from "node-schedule";
import { captchaManualAllowed, withCaptchaInteraction } from "../packages/hoyo-client/captcha.ts";
import { createCaptchaService } from "../lib/captcha/service.ts";
import { LegacyTasks } from "../lib/plugins/tasks.ts";
import { HandlerScope } from "../lib/plugins/handler.ts";

test("background profile notifications do not authorize manual verification", async () => {
  let registrations = 0;
  const service = createCaptchaService({ config: { order: ["manual"] }, providers: {
    available: () => false, async solve() { throw Error("unreachable"); },
  }, manualRelay: () => ({ async register() { registrations++; return undefined; }, async readResult() { return { status: "pending" }; } }) });
  const execute = () => service.run({ signal: new AbortController().signal, verify: async () => {},
    context: { qq: "42", profileId: 1 }, notify: () => true,
    challenge: async () => ({ captchaVersion: 4, captchaId: "fixture" }),
    accept: async () => ({ accepted: true, value: true }),
  });
  try {
    await execute();
    expect(registrations).toBe(0);
    expect(captchaManualAllowed(true)).toBe(false);
    await service.run({ signal: new AbortController().signal, verify: async () => {},
      allowManual: true, context: { qq: "42", profileId: 1 }, notify: () => true,
      manualProof: async () => { throw Error("unauthorized manual"); },
      challenge: async () => { throw Error("unauthorized challenge"); },
      accept: async () => ({ accepted: true, value: true }),
    });
    expect(registrations).toBe(0);
    await withCaptchaInteraction(() => true, execute);
    expect(registrations).toBe(2);
    await withCaptchaInteraction(() => false, () => service.run({ signal: new AbortController().signal,
      verify: async () => {}, allowManual: true, manualProof: async () => { throw Error("background manual"); },
      challenge: async () => ({ captchaVersion: 4, captchaId: "fixture" }),
      accept: async () => ({ accepted: true, value: true }),
    }));
    expect(registrations).toBe(2);
  } finally { await service.close(); }
});

test("scheduled callbacks deny inherited active command context", async () => {
  const tasks = new LegacyTasks();
  const owner = new HandlerScope();
  const baseline = new Set(Object.values(scheduledJobs));
  const result = Promise.withResolvers<boolean>();
  try {
    await withCaptchaInteraction(() => true, async () => {
      tasks.register(owner, { name: "captcha-policy", task: { cron: "0 0 1 1 *", log: false,
        fnc() { result.resolve(captchaManualAllowed(true)); },
      } });
      Object.values(scheduledJobs).find(job => !baseline.has(job))!.invoke();
      expect(await result.promise).toBe(false);
      expect(captchaManualAllowed()).toBe(true);
    });
    expect(captchaManualAllowed()).toBe(false);
    let current = true;
    const inherited = withCaptchaInteraction(() => current, () => new Promise<boolean>(resolve => {
      setTimeout(() => resolve(captchaManualAllowed()), 0);
    }));
    current = false;
    expect(await inherited).toBe(false);
  } finally { await tasks.stop(); }
});
