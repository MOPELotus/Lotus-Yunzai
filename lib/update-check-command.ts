import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { canManagePackages } from "./command-permissions.ts";
import type { MessageEvent } from "./messages.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";
import type { UpdateAvailability } from "./update-candidate-git.ts";

export function isUpdateCheckCommand(message: string): boolean {
  return message.trim() === "#检查更新";
}

export function describeUpdateAvailability(result: UpdateAvailability): string {
  const { branch, current, upstream, candidate, ahead, behind, dirty } = result;
  const status = ahead === undefined || behind === undefined ? upstream ? $t("lib.update-check-command.text_2b44f4cb8f") : $t("lib.update-check-command.text_5308371608")
    : ahead && behind ? $t("lib.update-check-command.text_96c4b64601")
    : ahead ? $t("lib.update-check-command.text_9972407459")
    : behind ? $t("lib.update-check-command.text_d7c9551906", { "behind": behind }) : $t("lib.update-check-command.text_ca9955f4ec");
  return [
    $t("lib.update-check-command.text_be80ac4542"),
    status,
    $t("lib.update-check-command.text_9f8126024a", { "value1": sanitizeRuntimeLog(branch) }),
    ...(upstream ? [$t("lib.update-check-command.text_1ce2e005ab", { "value1": sanitizeRuntimeLog(upstream) })] : []),
    ...(ahead !== undefined && behind !== undefined ? [$t("lib.update-check-command.text_34461841ce", { "ahead": ahead, "behind": behind })] : []),
    $t("lib.update-check-command.text_18dbe46483", { "current": current }),
    ...(candidate ? [$t("lib.update-check-command.text_2424961d11", { "candidate": candidate })] : []),
    ...(dirty ? [$t("lib.update-check-command.text_e3765bfa20")] : []),
  ].join("\n");
}

export function createUpdateCheckCommand(read: (signal: AbortSignal) => Promise<UpdateAvailability | undefined>) {
  return async (event: MessageEvent, signal: AbortSignal): Promise<void> => {
    if (!isUpdateCheckCommand(event.msg) || event.isDelegated || signal.aborted) return;
    if (!canManagePackages(event)) {
      await event.reply($t("lib.update-check-command.text_ee7b348d1b"));
      return;
    }
    await event.reply($t("lib.update-check-command.text_9cee08e8ea"));
    if (signal.aborted) return;
    let result: UpdateAvailability | undefined;
    try {
      result = await read(signal);
    } catch {
      // Git errors can contain credentials. The command only reports validated status fields.
    }
    if (!signal.aborted) await event.reply(result ? describeUpdateAvailability(result) : $t("lib.update-check-command.text_587097c491"));
  };
}
