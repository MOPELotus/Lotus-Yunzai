import { canManagePackages } from "./command-permissions.ts";
import type { MessageEvent } from "./messages.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";
import type { UpdateAvailability } from "./update-candidate-git.ts";

export function isUpdateCheckCommand(message: string): boolean {
  return message.trim() === "#检查更新";
}

function describe(result: UpdateAvailability): string {
  const { branch, current, upstream, candidate, ahead, behind, dirty } = result;
  const status = ahead === undefined || behind === undefined ? upstream ? "无法取得上游提交。" : "当前分支没有可用的上游。"
    : ahead && behind ? "本地分支与上游已分叉。"
    : ahead ? "本地分支领先于上游。"
    : behind ? `检测到上游有 ${behind} 个新提交。` : "当前已是最新版本。";
  return [
    "Lotus-Yunzai 更新检查",
    status,
    `分支：${sanitizeRuntimeLog(branch)}`,
    ...(upstream ? [`上游：${sanitizeRuntimeLog(upstream)}`] : []),
    ...(ahead !== undefined && behind !== undefined ? [`领先 ${ahead} 个提交 · 落后 ${behind} 个提交`] : []),
    `当前提交：${current}`,
    ...(candidate ? [`上游提交：${candidate}`] : []),
    ...(dirty ? ["工作区有未提交的修改。"] : []),
  ].join("\n");
}

export function createUpdateCheckCommand(read: (signal: AbortSignal) => Promise<UpdateAvailability | undefined>) {
  return async (event: MessageEvent, signal: AbortSignal): Promise<void> => {
    if (!isUpdateCheckCommand(event.msg) || event.isDelegated || signal.aborted) return;
    if (!canManagePackages(event)) {
      await event.reply("暂无权限，只有主人才能操作");
      return;
    }
    await event.reply("正在检查上游更新。");
    if (signal.aborted) return;
    let result: UpdateAvailability | undefined;
    try {
      result = await read(signal);
    } catch {
      // Git errors can contain credentials. The command only reports validated status fields.
    }
    if (!signal.aborted) await event.reply(result ? describe(result) : "无法检查更新，请核对 Git 工作区后重试。");
  };
}
