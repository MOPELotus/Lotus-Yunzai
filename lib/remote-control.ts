import { open } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteScope } from "./account-scope-policy.ts";
import type { MessageEvent } from "./messages.ts";
import { maxChatFileBytes } from "./chat-files.ts";
import { consumeRemoteOtp, remoteOtpPaired } from "./remote-otp.ts";
import { readRemoteFile, writeRemoteFile } from "./remote-files.ts";
import { remoteShell, remoteShells, type RemoteShell } from "./remote-shell.ts";

const command = /^#(?:远程(?:2FA|OTP)(?:初始化|重置|绑定|状态)|(?:远程管理员spawn|admin\s+spawn|远程spawn|spawn|远程下载|远程上传(?:覆盖)?|上传)(?:\s|$))/iu;
const settingsCommand = /^#远程(?:2FA|OTP)(初始化|重置|绑定|状态)$/iu;
const spawnCommand = /^#(远程管理员spawn|admin\s+spawn|远程spawn|spawn)\s+(\d{6})\s+(\S+)\s+([\s\S]+)$/iu;
const fileCommand = /^#(远程下载|远程上传(?:覆盖)?|上传)\s+(\d{6})\s+([\s\S]+)$/u;

export function isRemoteControlCommand(message: string) {
  if (/^#上传(?:\s|$)/u.test(message)) return /^#上传\s+\d{6}(?:\s|$)/u.test(message);
  return command.test(message);
}

interface Scope {
  readonly signal: AbortSignal;
  current(): boolean;
  allowed(permission: RemoteScope): Promise<boolean>;
}

export function readRemoteSettings(root: string) {
  let source = "";
  try { source = readFileSync(join(root, "config", "remote.yaml"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const settings = Bun.YAML.parse(source) as Record<string, unknown> | undefined;
  const shells = [...new Set((Array.isArray(settings?.shells) ? settings.shells : ["bash", "sh", "zsh"])
    .filter((name): name is RemoteShell => remoteShells.includes(name as RemoteShell)))];
  const timeout = settings?.timeout_ms;
  return {
    enabled: settings?.enable === true,
    allowAdmin: settings?.allow_admin === true,
    overwrite: settings?.allow_overwrite_upload === true,
    shells,
    timeout: typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout >= 100 && timeout <= 120_000
      ? timeout : 30_000,
  };
}

export function createRemoteControl(root: string) {
  let busy = false;
  let failures: number[] = [];
  function authorize(token: string) {
    const now = Date.now();
    failures = failures.filter(time => now - time < 30_000);
    if (failures.length >= 5) return "验证码尝试过多，请稍后重试。";
    if (!consumeRemoteOtp(root, token, now)) {
      failures.push(now);
      return "验证码无效、已使用或尚未配对。";
    }
    failures = [];
  }
  async function rememberAuthorization(permission: RemoteScope, event: MessageEvent) {
    const audit = join(root, "data", "remote-auth", "operations.jsonl");
    await using file = await open(audit, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    if (!(await file.stat()).isFile()) throw new Error("运维审计须为普通文件。");
    await file.writeFile(JSON.stringify({
      at: new Date().toISOString(), action: permission, adapter: event.adapter ?? "onebot",
      bot: event.self_id, owner: event.user_id,
    }) + "\n");
  }
  const guide = "请在私人本机终端运行 bun scripts/remote-otp.ts setup 配对，更换验证器使用 reset。";
  return async function handle(event: MessageEvent, scope: Scope) {
    const reply = (body: string) => scope.current() ? event.reply(body) : undefined;
    if (!scope.current()) return;
    const settingsAction = settingsCommand.exec(event.msg)?.[1];
    if (settingsAction) {
      if (!await scope.allowed("remote.spawn") || !scope.current()) return;
      if (settingsAction !== "状态") {
        await reply(guide);
        return;
      }
      let paired = false;
      let enabled = false;
      try {
        paired = remoteOtpPaired(root);
        enabled = readRemoteSettings(root).enabled;
      } catch {
        await reply("无法读取远程身份验证状态，请到本机核对。");
        return;
      }
      const image = await import("./remote-status-card.ts")
        .then(({ renderRemoteStatusCard }) => renderRemoteStatusCard(paired, enabled)).catch(() => undefined);
      if (!scope.current() || !await scope.allowed("remote.spawn") || !scope.current()) return;
      if (image && await event.reply({ type: "image", file: image.png }) !== false) return;
      await reply(paired ? "远程身份验证已配对。" : `远程身份验证未配对。${guide}`);
      return;
    }

    const spawn = spawnCommand.exec(event.msg);
    const file = fileCommand.exec(event.msg);
    if ((!spawn && !file) || event.msg.length > 4_096) {
      await reply("格式无效。远程命令需验证码、Shell 和命令，文件操作需验证码和目标路径。");
      return;
    }
    if (busy) {
      await reply("已有远程运维操作，请稍后再试。");
      return;
    }
    busy = true;
    try {
      const permission = spawn ? "remote.spawn" : file?.[1] === "远程下载" ? "remote.download" : "remote.upload";
      const stillAllowed = async () => await scope.allowed(permission) && scope.current();
      if (!await stillAllowed()) return;
      const settings = readRemoteSettings(root);
      if (!scope.current()) return;
      if (!settings.enabled) {
        await reply("远程运维未开启。");
        return;
      }
      if (process.platform !== "linux") {
        await reply("当前平台未接入远程运维。");
        return;
      }
      if (spawn) {
        const shell = spawn[3]!.toLowerCase() as RemoteShell;
        if (!settings.shells.includes(shell)) {
          await reply("所选 Shell 未启用。");
          return;
        }
        const admin = /^(?:远程管理员|admin)/iu.test(spawn[1]!);
        if (admin && (!settings.allowAdmin || process.getuid?.() !== 0)) {
          await reply("管理员模式须显式开启，并且宿主已用管理员权限运行。");
          return;
        }
        const denied = authorize(spawn[2]!);
        if (denied) {
          await reply(denied);
          return;
        }
        await rememberAuthorization(permission, event);
        if (!await stillAllowed()) return;
        const currentSettings = readRemoteSettings(root);
        if (!currentSettings.enabled || !currentSettings.shells.includes(shell) ||
            (admin && !currentSettings.allowAdmin)) return;
        await reply(await remoteShell(root, shell, spawn[4]!, scope.signal, currentSettings.timeout));
        return;
      }

      const action = file![1]!;
      const target = file![3]!.trim();
      const download = action === "远程下载";
      if (download ? !event.uploadFile : !event.canReadAttachments || !event.attachment) {
        await reply(download ? "当前私聊不支持发送文件。" : "请在同一条消息附带可读取的文件。");
        return;
      }
      const denied = authorize(file![2]!);
      if (denied) {
        await reply(denied);
        return;
      }
      await rememberAuthorization(permission, event);
      if (!await stillAllowed() || !readRemoteSettings(root).enabled) return;
      if (download) {
        const content = await readRemoteFile(root, target, scope.signal);
        if (!content || !await stillAllowed() || !readRemoteSettings(root).enabled) {
          await reply("未能读取目标文件。");
          return;
        }
        const result = await event.uploadFile!(content);
        await reply(result === "confirmed" ? "远程下载已发送。" : result === "unknown"
          ? "文件发送结果未确认，请先核对当前私聊。" : "文件未能发送。");
        return;
      }

      const attachment = event.attachment!;
      const bytes = await attachment.read(scope.signal);
      if (!bytes || bytes.byteLength > maxChatFileBytes ||
          (attachment.size !== undefined && attachment.size !== bytes.byteLength)) {
        await reply("未能读取所附文件。");
        return;
      }
      if (!await stillAllowed()) return;
      const currentSettings = readRemoteSettings(root);
      if (!currentSettings.enabled) return;
      const allowOverwrite = action === "远程上传覆盖" || currentSettings.overwrite;
      const written = await writeRemoteFile(root, target, bytes, allowOverwrite, async () => {
        if (!await stillAllowed()) return false;
        const latest = readRemoteSettings(root);
        return latest.enabled && (!allowOverwrite || action === "远程上传覆盖" || latest.overwrite);
      });
      await reply(written ? "远程上传已保存。" : "远程上传未能保存。");
    } catch {
      await reply("远程运维未能完成，请在本机核对配置、权限或目标。");
    } finally {
      busy = false;
    }
  };
}
