import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelProcessScheduleSettings } from "../lib/panel-process-schedule-settings.ts";
import { defaultUpdateNoticeCron, type UpdateNoticeSettings } from "../lib/update-notice.ts";
import { HandlerScope } from "../lib/plugins/handler.ts";
import { LegacyTasks, legacyHostCronTimeZone } from "../lib/plugins/tasks.ts";

test("宿主定时设置沿用现行读取优先级并安全保存 Cron 和间隔", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-process-"));
  const root = pathToFileURL(directory + "/");
  const endpoint = "http://localhost/panel/api/settings/native/process-schedule";
  const tasks = new LegacyTasks(undefined, legacyHostCronTimeZone);
  let executions = 0;
  const applied: UpdateNoticeSettings[] = [];
  const handle = panelProcessScheduleSettings(root, cron => {
    try {
      const staged = tasks.prepare([{ owner: new HandlerScope(), app: {
        name: "调度设置回归", task: { cron, fnc: () => { executions++; } },
      } }]);
      staged.cancel();
      return true;
    } catch {
      return false;
    }
  }, settings => applied.push(settings));
  const get = async () => (await handle(new Request(endpoint), () => true)).json();
  const put = (previous: unknown, values: unknown, authorized = () => true) => handle(new Request(endpoint, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previous, values }),
  }), authorized);
  try {
    await mkdir(join(directory, "config/config"), { recursive: true });
    const legacy = join(directory, "config/config/bot.yaml");
    const modern = join(directory, "config/bot.yaml");
    const legacySource = '# 旧宿主调度\nrestart_time: "1e1"\nstop_cron: "0 1 * * *"\npanel_token: fixture\n';
    await writeFile(legacy, legacySource);
    const snapshot = await get();
    expect(snapshot.fields).toHaveLength(8);
    expect(snapshot.fields.find(({ key }: { key: string }) => key === "update_cron").separator).toBe("line");
    expect(snapshot.values).toEqual({
      update_notice: false, update_notice_cron: defaultUpdateNoticeCron,
      update_time: 1440, restart_time: 10, update_cron: [], restart_cron: [], stop_cron: ["0 1 * * *"], start_cron: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("fixture");
    const values = { ...snapshot.values, update_time: 0.5, update_cron: ["1,15 12 * * *"], stop_cron: [],
      start_cron: ["30 0 8 * * *", "0 20 * * *"] };
    expect((await put(snapshot.values, { ...values, update_cron: ["0 32 * * *"] })).status).toBe(400);
    expect((await put(snapshot.values, { ...values, restart_time: Number.MAX_SAFE_INTEGER })).status).toBe(400);
    let checks = 0;
    expect((await put(snapshot.values, values, () => ++checks === 1)).status).toBe(401);
    expect(await readFile(legacy, "utf8")).toBe(legacySource);
    expect((await put(snapshot.values, values)).status).toBe(200);
    expect(await Bun.file(modern).exists()).toBe(false);
    const updated = await readFile(legacy, "utf8");
    expect(updated).toContain("# 旧宿主调度");
    expect(Bun.YAML.parse(updated)).toEqual({
      restart_time: "1e1", stop_cron: false, panel_token: "fixture", update_cron: "1,15 12 * * *",
      update_time: 0.5, start_cron: ["30 0 8 * * *", "0 20 * * *"],
    });
    expect((await get()).values).toEqual(values);
    expect((await put(snapshot.values, values)).status).toBe(409);

    await writeFile(modern, "other: true\n");
    const current = (await get()).values;
    expect(current).toEqual({
      update_notice: false, update_notice_cron: defaultUpdateNoticeCron,
      update_time: 0, restart_time: 0, update_cron: [], restart_cron: [], stop_cron: [], start_cron: [],
    });
    expect((await put(current, { ...current, restart_cron: ["0 12 * * *"] })).status).toBe(200);
    expect(Bun.YAML.parse(await readFile(modern, "utf8"))).toEqual({ other: true, restart_cron: "0 12 * * *" });
    const latest = (await get()).values;
    expect((await put(latest, { ...latest, update_notice: true, update_notice_cron: "0 32 * * *" })).status).toBe(400);
    expect((await put(latest, { ...latest, update_notice: true, update_notice_cron: "0 2 * * *" })).status).toBe(200);
    expect(applied).toEqual([{ update_notice: true, update_notice_cron: "0 2 * * *" }]);
    expect(Bun.YAML.parse(await readFile(modern, "utf8"))).toEqual({
      other: true, restart_cron: "0 12 * * *", update_notice: true, update_notice_cron: "0 2 * * *",
    });
    expect(executions).toBe(0);
  } finally {
    await tasks.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
