import type { ManagedUpdateProgress } from "./managed-update-protocol.ts";
import type { MessageEvent } from "./messages.ts";
import { canManagePackages } from "./package-command-permissions.ts";
import { parseUpdateTarget } from "./update-target.ts";

type RequestUpdate = (event: MessageEvent, requested: string | undefined, quiet: boolean,
  report: (status: ManagedUpdateProgress) => void, all: boolean, force: boolean) => boolean | Promise<boolean>;

const command = /^#(全部)?(安?静)?(强制)?更新/u;
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

export function describeUpdateProgress(status: ManagedUpdateProgress): string {
  return replies[status];
}

function updatePrefix(message: string): RegExpExecArray | undefined {
  const match = command.exec(message);
  if (!match || (match[1] === undefined && message.startsWith("日志", match[0].length))) return;
  return match;
}

export function isUpdateCommand(text: string): boolean {
  return updatePrefix(text.trimStart()) !== undefined;
}

export function hasValidUpdateTarget(text: string): boolean {
  const message = text.trimStart();
  const match = updatePrefix(message);
  if (!match) return false;
  const requested = parseUpdateTarget(message.slice(match[0].length));
  return requested !== undefined && (match[1] === undefined || requested === "");
}

export function createUpdateCommand(request: RequestUpdate) {
  return async (event: MessageEvent): Promise<void> => {
    const message = event.msg.trimStart();
    const match = updatePrefix(message);
    if (!match) return;
    if (!canManagePackages(event)) {
      await event.reply("暂无权限，只有主人才能操作");
      return;
    }

    const all = match[1] !== undefined;
    const quiet = match[2] !== undefined;
    const force = match[3] !== undefined;
    const requested = parseUpdateTarget(message.slice(match[0].length));
    if (all && requested !== "") {
      await event.reply(force ? "请只发送 #全部强制更新、#全部静强制更新 或 #全部安静强制更新。"
        : "请只发送 #全部更新、#全部静更新 或 #全部安静更新。");
      return;
    }
    if (requested === undefined) {
      const example = force ? "#强制更新" : "#更新";
      await event.reply(`请输入有效的插件名，例如 ${example} system 或 ${example} @lotus-yunzai/system。`);
      return;
    }

    let pending = Promise.resolve();
    const report = (status: ManagedUpdateProgress) => {
      if (quiet && quietStatuses.has(status)) return;
      const reply = force && status === "checking" ? "开始强制更新，正在检查上游。" : replies[status];
      pending = pending.then(async () => { await event.reply(reply); }).catch(() => undefined);
    };
    let sent: boolean;
    try {
      sent = await request(event, requested || undefined, quiet, report, all, force);
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
