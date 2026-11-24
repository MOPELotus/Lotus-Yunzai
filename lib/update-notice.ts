import { isMap, parseDocument } from "yaml";
import { readLocalConfig } from "./config.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { HandlerScope } from "./plugins/handler.ts";
import { legacyHostCronTimeZone, LegacyTasks } from "./plugins/tasks.ts";
import type { UpdateAvailability } from "./update-candidate-git.ts";
import { describeUpdateAvailability } from "./update-check-command.ts";

export const defaultUpdateNoticeCron = "0 */10 * * * *";

export interface UpdateNoticeSettings {
  readonly update_notice: boolean;
  readonly update_notice_cron: string;
}

export function readUpdateNoticeSettings(config: Readonly<Record<string, unknown>>): UpdateNoticeSettings {
  return {
    update_notice: config.update_notice === true,
    update_notice_cron: typeof config.update_notice_cron === "string" ? config.update_notice_cron : defaultUpdateNoticeCron,
  };
}

export function normalizedUpdateNoticeCron(input: string) {
  if (input.length > 160 || /[\r\n]/u.test(input)) return;
  const cron = input.trim().replace(/\s+/gu, " ");
  const fields = cron.split(" ").length;
  return fields === 5 || fields === 6 ? cron : undefined;
}

export function updateNoticeSettingCommand(message: string): Partial<UpdateNoticeSettings> | undefined {
  const command = message.trim();
  if (command === "#开启更新推送" || command === "#关闭更新推送") {
    return { update_notice: command === "#开启更新推送" };
  }
  const cron = /^#设置检查更新时间\s*(.*)$/u.exec(command)?.[1];
  if (cron !== undefined) return { update_notice_cron: cron };
}

export async function persistUpdateNoticeSettings(
  root: URL, change: Partial<UpdateNoticeSettings>, signal: AbortSignal, authorize: () => boolean,
  apply: (settings: UpdateNoticeSettings) => void, validateCron: (input: string) => boolean,
) {
  const canWrite = () => !signal.aborted && authorize();
  return updateLocalConfiguration(root, "bot", {
    signal, canWrite, canCommit: canWrite, onCommitted: apply,
    resolveEffective: () => readLocalConfig(root, "bot"),
    prepare(content, local, effective) {
      const current = readUpdateNoticeSettings(effective);
      const value = { ...current, ...change };
      if (value.update_notice && !validateCron(value.update_notice_cron)) throw new GlobalConfigWriteError("config");
      const keys = (Object.keys(change) as (keyof UpdateNoticeSettings)[]).filter(key => value[key] !== current[key]);
      if (!keys.length) return { value };
      const document = parseDocument(content, { strict: true, uniqueKeys: true, merge: true });
      if (document.errors.length || document.contents && !isMap(document.contents)) throw new GlobalConfigWriteError("config");
      for (const key of keys) document.set(key, value[key]);
      const yaml = document.toString({ lineWidth: 0 });
      const expected = { ...local, ...Object.fromEntries(keys.map(key => [key, value[key]])) };
      if (!Bun.deepEquals(Bun.YAML.parse(yaml), expected)) throw new GlobalConfigWriteError("config");
      return { yaml, value };
    },
  });
}

type SendOutcome = "confirmed" | "rejected" | "unknown";

export function createUpdateNotices(options: {
  signal: AbortSignal;
  accepting: () => boolean;
  read: (signal: AbortSignal) => Promise<UpdateAvailability | undefined>;
  send: (message: string, signal: AbortSignal) => Promise<SendOutcome>;
}) {
  const tasks = new LegacyTasks(options.accepting, legacyHostCronTimeZone);
  const owner = new HandlerScope();
  const sent = new Set<string>();
  let settings: UpdateNoticeSettings | undefined;
  let active: { controller: AbortController; done: Promise<void> } | undefined;

  function trigger() {
    if (active || !options.accepting() || options.signal.aborted) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, options.signal]);
    const done = Promise.resolve().then(async () => {
      if (signal.aborted || !options.accepting()) return;
      const result = await options.read(signal);
      if (!result?.candidate || !result.behind || signal.aborted || !options.accepting() || sent.has(result.candidate)) return;
      const message = [describeUpdateAvailability(result), ...(result.changes ?? [])].join("\n");
      const status = await options.send(message, signal);
      if (status === "rejected") return;
      sent.add(result.candidate);
      if (sent.size > 64) sent.delete(sent.values().next().value!);
    }).catch(() => {
      if (!signal.aborted) console.warn("[更新推送] 无法检查候选或确认主人通知。");
    }).finally(() => { active = undefined; });
    active = { controller, done };
    return done;
  }

  function interrupt() {
    active?.controller.abort();
    return active?.done;
  }

  function apply(next: UpdateNoticeSettings) {
    if (options.signal.aborted || settings?.update_notice === next.update_notice &&
        settings.update_notice_cron === next.update_notice_cron) return;
    const name = "宿主更新推送";
    const app = { name, task: { cron: next.update_notice_cron, fnc: trigger, log: false } };
    const prepared = tasks.prepare(next.update_notice ? [{ owner, app }] : [], new Set([owner]));
    void interrupt();
    prepared.publish();
    settings = next;
  }

  return {
    apply,
    interrupt,
    initialize(next: UpdateNoticeSettings) {
      if (!settings) apply(next);
    },
    async stop() {
      await Promise.all([interrupt(), tasks.stop()]);
      owner.dispose();
    },
  };
}
