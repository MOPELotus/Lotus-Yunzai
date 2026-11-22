import { expect, test } from "bun:test";
import { cp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

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

test("UTC 宿主按北京时间注册保留的自动群名片配置", async () => {
  const cron = "0 34 22 * * *";
  const trace = "native-cron-trace.json";
  const preload = `
    import { writeFileSync } from "node:fs";
    import { Job } from "node-schedule";
    process.env.TZ = "UTC";
    const originalSchedule = Job.prototype.schedule;
    Job.prototype.schedule = function (spec) {
      const registered = originalSchedule.call(this, spec);
      const rule = typeof spec === "string" ? spec : spec?.rule;
      if (registered && rule === ${JSON.stringify(cron)}) {
        const next = new Date(this.nextInvocation().getTime());
        writeFileSync(${JSON.stringify(trace)}, JSON.stringify({
          processZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          nextHour: next.getUTCHours(), nextMinute: next.getUTCMinutes(),
        }));
      }
      return registered;
    };
  `;
  await withDualGatewayFixture("native-cron-timezone", "", async ({ root }) => {
    const result = Bun.file(join(root, trace));
    for (let attempt = 0; attempt < 50 && !await result.exists(); attempt++) await Bun.sleep(20);
    expect(await result.json()).toEqual({ processZone: "UTC", nextHour: 14, nextMinute: 34 });
  }, 2_000, preload, async root => {
    await cp(new URL("../plugins/group/", import.meta.url), join(root, "plugins/group"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await writeFile(join(root, "config/config/auto-group-card.yaml"), `enable: true\ncron: '${cron}'\n`);
  });
}, 8_000);
