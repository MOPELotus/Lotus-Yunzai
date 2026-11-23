import type { ManagedUpdateProgress } from "./managed-update-protocol.ts";
import type { MessageEvent } from "./messages.ts";
import { canManagePackages } from "./command-permissions.ts";
import { parseUpdateTarget } from "./update-target.ts";

type RequestUpdate = (event: MessageEvent, requested: string | undefined, quiet: boolean,
  report: (status: ManagedUpdateProgress) => void, all: boolean, force: boolean) => boolean | Promise<boolean>;

const command = /^#(全部)?(安?静)?(强制)?更新/u;
const legacyStarRailWarpUpdate = /^#?(?:\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)抽卡(?:插件)?(强制)?更新$/u;
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
  "storage-changed": "Valkey 配置已变更或无法读取，当前宿主继续运行。要启用新配置，请先正常停机再启动。",
  failed: "更新失败，请检查宿主日志。",
};

export function describeUpdateProgress(status: ManagedUpdateProgress): string {
  return replies[status];
}

function updatePrefix(message: string): RegExpExecArray | undefined {
  // 旧业务命令停用后仍不应触发仓库更新。
  if (/^#(?:强制)?更新(?:配队|攻略|摩拉)资源(?:\s|$)/u.test(message)) return;
  if (/^#更新\S+(?:攻略[1-7]?|一图流)$/u.test(message.trimEnd())) return;
  if (/^#(?:原神)?更新\S+(?:突破|材料|素材|培养)$/u.test(message.trimEnd())) return;
  if (/^#更新群名片(?:\s|$)/u.test(message)) return;
  if (/^#更新(?:图鉴|抽卡记录(?:[1-9]\d{0,2})?|(?:全部|所有)抽卡记录)$/u.test(message.trimEnd())) return;
  if (/^#更新(?:充值|消费)(?:记录|统计)(?:\s+(?:档案|profile)\s*\d{1,3})?$/iu.test(message.trimEnd())) return;
  if (/^#更新(?:全部)?面板\s*(?:[1-9]\d{0,2}|[1-9]\d{8,9})?$/u.test(message.trimEnd())) return;
  if (/^#更新(?:提瓦特)?小助手(?:抽卡|祈愿)?(?:记录|历史)(?:[1-9]\d{0,2})?(?:\s|$)/u.test(message)) return;
  const match = command.exec(message);
  if (!match || (match[1] === undefined && message.startsWith("日志", match[0].length))) return;
  return match;
}

function updateInput(text: string) {
  const message = text.trimStart();
  const legacy = legacyStarRailWarpUpdate.exec(message.trimEnd());
  return legacy ? `#${legacy[1] ?? ""}更新 starrail` : message;
}

export function isUpdateCommand(text: string): boolean {
  return updatePrefix(updateInput(text)) !== undefined;
}

export function hasValidUpdateTarget(text: string): boolean {
  const message = updateInput(text);
  const match = updatePrefix(message);
  if (!match) return false;
  const requested = parseUpdateTarget(message.slice(match[0].length));
  return requested !== undefined && (match[1] === undefined || requested === "");
}

export function createUpdateCommand(request: RequestUpdate) {
  return async (event: MessageEvent): Promise<void> => {
    const message = updateInput(event.msg);
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
      await event.reply("当前未启用受管更新。请在宿主目录运行 bun run start 后重试。");
      return;
    }
    await pending;
  };
}
