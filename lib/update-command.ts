import type { ManagedUpdateProgress } from "./managed-update-protocol.ts";
import type { MessageEvent } from "./messages.ts";
import { parseUpdateTarget } from "./update-target.ts";

type RequestUpdate = (event: MessageEvent, requested: string | undefined, quiet: boolean,
  report: (status: ManagedUpdateProgress) => void) => boolean;

const command = /^#(?:安?静)?更新(?!日志)/u;
const quietStatuses = new Set<ManagedUpdateProgress>(["checking", "building", "switching", "current"]);
const replies: Readonly<Record<ManagedUpdateProgress, string>> = {
  checking: "开始更新，正在检查上游。",
  building: "正在准备候选版本。",
  switching: "正在切换到候选版本。",
  busy: "已有更新或进程切换正在进行，请稍后再试。",
  current: "当前已是最新版本。",
  dirty: "工作区有未提交的修改，更新未执行。",
  ahead: "当前提交领先于上游，更新未执行。",
  diverged: "当前提交与上游已分叉，更新未执行。",
  rejected: "更新候选未通过检查，更新未执行。",
  unavailable: "无法取得更新候选，请检查更新目标和上游配置。",
  failed: "更新失败，请检查宿主日志。",
};

export function isUpdateCommand(text: string): boolean {
  return command.test(text.trimStart());
}

export function createUpdateCommand(request: RequestUpdate) {
  return async (event: MessageEvent): Promise<void> => {
    const message = event.msg.trimStart();
    const match = command.exec(message);
    if (!match) return;
    if (event.isMaster !== true || (event.message_type !== "terminal" && event.boundAccount !== true)) {
      await event.reply("暂无权限，只有主人才能操作");
      return;
    }

    const requested = parseUpdateTarget(message.slice(match[0].length));
    if (requested === undefined) {
      await event.reply("请输入有效的插件名，例如 #更新 system 或 #更新 @lotus-yunzai/system。");
      return;
    }

    const quiet = match[0] !== "#更新";
    let pending = Promise.resolve();
    const report = (status: ManagedUpdateProgress) => {
      if (quiet && quietStatuses.has(status)) return;
      pending = pending.then(async () => { await event.reply(replies[status]); }).catch(() => undefined);
    };
    let sent: boolean;
    try {
      sent = request(event, requested || undefined, quiet, report);
    } catch {
      await event.reply("发送更新请求失败，请稍后重试。");
      return;
    }
    if (!sent) {
      await event.reply("当前未启用受管更新。请在宿主目录运行 bun scripts/run-managed.ts 后重试。");
      return;
    }
    await pending;
  };
}
