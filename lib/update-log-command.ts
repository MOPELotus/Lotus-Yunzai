import { replyWithLog } from "./log-reply.ts";
import type { MessageEvent } from "./messages.ts";
import type { UpdateHistory } from "./update-history.ts";

const command = "#更新日志";
const pluginName = /^(?:[\p{L}\p{N}][\p{L}\p{N}._-]*|@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)$/u;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const mismatchNotice = "当前检出的插件版本与宿主锁定版本不同，以下日志按宿主锁定版本列出。";

export function isUpdateLogCommand(message: string): boolean {
  return message.trimStart().startsWith(command);
}

export function createUpdateLogCommand(read: (requested?: string) => Promise<UpdateHistory | undefined>) {
  return async (event: MessageEvent): Promise<boolean> => {
    const message = event.msg.trimStart();
    if (!message.startsWith(command)) return false;

    const argument = message.slice(command.length);
    const requested = argument.trim();
    if (controls.test(argument) || requested.length > 214 || (requested && !pluginName.test(requested))) {
      await event.reply("请输入有效的插件名，例如 #更新日志 system 或 #更新日志 @lotus-yunzai/system。");
      return true;
    }

    let log: UpdateHistory | undefined;
    try {
      log = await read(requested || undefined);
    } catch {
      await event.reply("读取更新日志失败，请稍后重试。");
      return true;
    }
    if (!log) {
      await event.reply("暂无可用的更新日志。");
      return true;
    }

    const title = `${log.name} 更新日志，共${log.lines.length}条`;
    const heading = log.pinnedMismatch ? `${title}\n${mismatchNotice}` : title;
    if (!log.lines.length) {
      await event.reply(heading);
      return true;
    }
    await replyWithLog(event, heading, log.lines, {
      separator: "\n\n",
      unconfirmed: "更新日志转发结果未确认，请在聊天中核对。",
    });
    return true;
  };
}
