import type { MessageEvent } from "./messages.ts";

export type InstallProgress = "checking" | "building" | "switching" | "busy" | "exists" | "unavailable" | "rejected" | "failed";

interface InstallCallbacks {
  list(event: MessageEvent): readonly string[] | Promise<readonly string[]>;
  install(event: MessageEvent, shortName: string, report: (status: InstallProgress) => void): boolean | Promise<boolean>;
}

const command = "#安装";
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const shortName = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const suffix = /-[Pp]lugin$/u;
const replies: Readonly<Record<InstallProgress, string>> = {
  checking: "开始安装，正在检查插件目录。",
  building: "正在准备插件和依赖。",
  switching: "正在切换到安装后的宿主。",
  busy: "正在安装，请稍候再试",
  exists: "该插件已安装。",
  unavailable: "暂无可用的安装目标，请用 #安装插件 查看列表。",
  rejected: "插件候选未通过检查，安装未执行。",
  failed: "插件安装失败，请检查宿主日志。",
};

export function isInstallName(name: unknown): name is string {
  return typeof name === "string" && shortName.test(name) && !name.includes("..");
}

export function parseInstallName(argument: string): string | undefined {
  if (controls.test(argument)) return;
  const name = argument.trim().replace(suffix, "");
  if (!isInstallName(name)) return;
  return name;
}

export function isInstallCommand(message: string): boolean {
  return message.trimStart().startsWith(command);
}

export function createInstallCommand(callbacks: InstallCallbacks) {
  return async (event: MessageEvent): Promise<void> => {
    const message = event.msg.trimStart();
    if (!message.startsWith(command)) return;
    if (event.isMaster !== true || (event.message_type !== "terminal" && event.boundAccount !== true)) {
      await event.reply("暂无权限，只有主人才能操作");
      return;
    }

    const name = parseInstallName(message.slice(command.length));
    if (!name) {
      await event.reply("请发送 #安装插件 查看可安装插件，再用 #安装插件名 进行安装。");
      return;
    }
    if (name === "插件") {
      let names: readonly string[];
      try {
        const listed = await callbacks.list(event);
        names = [...new Set(listed.filter((label) => {
          const parsed = parseInstallName(label);
          return parsed !== undefined && parsed !== "插件" && label.trim() === label;
        }))];
      } catch {
        await event.reply("读取可安装插件列表失败，请稍后重试。");
        return;
      }
      await event.reply(names.length
        ? ["可安装插件列表：", ...names, "发送 #安装+插件名 进行安装"].join("\n")
        : "暂无可安装插件");
      return;
    }

    let pending = Promise.resolve();
    const report = (status: InstallProgress) => {
      pending = pending.then(async () => { await event.reply(replies[status]); }).catch(() => undefined);
    };
    let sent: boolean;
    try {
      sent = await callbacks.install(event, name, report);
    } catch {
      await event.reply("发送安装请求失败，请稍后重试。");
      return;
    }
    if (!sent) {
      await event.reply("当前未启用受管安装。请在宿主目录运行 bun scripts/run-managed.ts 后重试。");
      return;
    }
    await pending;
  };
}
