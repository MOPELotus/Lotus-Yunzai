import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { basename, join } from "node:path";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";
import { HandlerScope } from "./plugins/handler.ts";
import { legacyHostCronTimeZone, LegacyTasks } from "./plugins/tasks.ts";
import { normalizedUpdateNoticeCron, type UpdateNoticeSettings } from "./update-notice.ts";

const mergedZzz = rejectionReason(["zzz-plugin"], []);

function record(value: unknown) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export async function readLegacyZzzUpdateNotice(archive: string | undefined,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal,
): Promise<{ settings?: Partial<UpdateNoticeSettings>; deferred: boolean }> {
  if (!archive) return { deferred: false };
  const candidates = plugins.filter(plugin => plugin.status === "archive" && plugin.kind === "directory" && plugin.reason === mergedZzz);
  const canonical = candidates.find(plugin => plugin.path === "plugins/ZZZ-Plugin") ?? candidates[0];
  if (!canonical) return { deferred: false };
  const path = join(archive, basename(canonical.path), "config", "config.yaml");
  const file = await readMigrationSourceFile(archive, path, 256 * 1024, signal);
  if (!file) return { deferred: false };
  try {
    const parsed: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    const raw = record(parsed)?.update;
    if (raw === undefined) return { deferred: parsed != null && !record(parsed) };
    const update = record(raw);
    if (!update || update.autoCheck !== undefined && typeof update.autoCheck !== "boolean") return { deferred: true };
    const cron = typeof update.cron === "string" ? normalizedUpdateNoticeCron(update.cron) : undefined;
    if (update.cron !== undefined && !cron) return { deferred: true };
    if (cron) {
      const tasks = new LegacyTasks(undefined, legacyHostCronTimeZone);
      const owner = new HandlerScope();
      try {
        const prepared = tasks.prepare([{ owner, app: {
          name: $t("lib.migration-zzz-update-notice.text_a531bbfa7b"), task: { cron, fnc() {}, log: false },
        } }]);
        prepared.cancel();
      } finally {
        await tasks.stop();
        owner.dispose();
      }
    }
    const settings = {
      ...(typeof update.autoCheck === "boolean" ? { update_notice: update.autoCheck } : {}),
      ...(cron ? { update_notice_cron: cron } : {}),
    };
    return Object.keys(settings).length ? { settings, deferred: false } : { deferred: false };
  } catch { return { deferred: true }; }
}
