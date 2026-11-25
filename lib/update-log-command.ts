import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { replyWithLog } from "./log-reply.ts";
import type { MessageEvent } from "./messages.ts";
import type { UpdateHistory } from "./update-history.ts";
import { parseUpdateTarget } from "./update-target.ts";

const command = "#更新日志";
const starRailLog = /^#星铁(?:插件)?更新日志$/u;
const mismatchNotice = $t("lib.update-log-command.text_1ecfa80050");

export function isUpdateLogCommand(message: string): boolean {
  return message.trimStart().startsWith(command) || starRailLog.test(message.trim());
}

export function createUpdateLogCommand(read: (requested?: string) => Promise<UpdateHistory | undefined>) {
  return async (event: MessageEvent): Promise<boolean> => {
    const message = event.msg.trimStart();
    const starRail = starRailLog.test(message.trimEnd());
    if (!starRail && !message.startsWith(command)) return false;

    const requested = starRail ? "starrail" : parseUpdateTarget(message.slice(command.length));
    if (requested === undefined) {
      await event.reply($t("lib.update-log-command.text_9790f939cf"));
      return true;
    }

    let log: UpdateHistory | undefined;
    try {
      log = await read(requested || undefined);
    } catch {
      await event.reply($t("lib.update-log-command.text_3f1fbde032"));
      return true;
    }
    if (!log) {
      await event.reply($t("lib.update-log-command.text_82a1b4249c"));
      return true;
    }

    const title = $t("lib.update-log-command.text_774b663722", { "name": log.name, "length": log.lines.length });
    const heading = log.pinnedMismatch ? `${title}\n${mismatchNotice}` : title;
    if (!log.lines.length) {
      await event.reply(heading);
      return true;
    }
    await replyWithLog(event, heading, log.lines, {
      separator: "\n\n",
      unconfirmed: $t("lib.update-log-command.text_548e671a33"),
    });
    return true;
  };
}
