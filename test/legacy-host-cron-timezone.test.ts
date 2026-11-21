import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("旧宿主的四类 cron 沿用上海时区，普通插件仍用进程时区", async () => {
  const child = Bun.spawn([process.execPath, "--eval", `
    import { scheduledJobs } from "node-schedule";
    import { scheduleDispatchPower } from "./lib/dispatch-power-schedule.ts";
    import { scheduleProcessRestart } from "./lib/process-restart-schedule.ts";
    import { scheduleUpdates } from "./lib/update-schedule.ts";
    import { HandlerScope } from "./lib/plugins/handler.ts";
    import { LegacyTasks } from "./lib/plugins/tasks.ts";

    const cron = "0 0 22 * * *";
    const noop = () => {};
    const stopPower = scheduleDispatchPower({ stop_cron: cron, start_cron: cron }, noop);
    const stopRestart = scheduleProcessRestart({ restart_cron: cron }, noop);
    const stopUpdate = scheduleUpdates({ update_cron: cron }, noop);
    const clocks = () => Object.values(scheduledJobs).map(job => job.nextInvocation().getTime());
    const host = clocks();

    const plugin = new LegacyTasks();
    plugin.register(new HandlerScope(), { name: "本地时区夹具", task: { cron, fnc: noop } });
    const local = clocks().filter(time => !host.includes(time));
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await Promise.all([stopPower(), stopRestart(), stopUpdate(), plugin.stop()]);
    console.log(JSON.stringify({ timeZone, host, local }));
  `], {
    cwd: resolve(import.meta.dir, ".."), env: { PATH: process.env.PATH, TZ: "UTC" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3500,
  });
  const [code, output, error] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  const { timeZone, host, local } = JSON.parse(output) as { timeZone: string; host: number[]; local: number[] };
  expect(timeZone).toBe("UTC");
  expect(host.map(time => new Date(time).getUTCHours())).toEqual([14, 14, 14, 14]);
  expect(local.map(time => new Date(time).getUTCHours())).toEqual([22]);
});
