import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { open } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteScope } from "./account-scope-policy.ts";
import type { MessageEvent } from "./messages.ts";
import { maxChatFileBytes } from "./chat-files.ts";
import { consumeRemoteOtp, remoteOtpPaired } from "./remote-otp.ts";
import { readRemoteFile, writeRemoteFile } from "./remote-files.ts";
import { isRemoteAdministrator, isRemotePlatformSupported, remoteShell, remoteShells, type RemoteShell } from "./remote-shell.ts";

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
  const platformShells = process.platform === "win32" ? ["pwsh", "powershell", "cmd"] : ["bash", "sh", "zsh"];
  const shells = [...new Set((Array.isArray(settings?.shells) ? settings.shells : platformShells)
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
    if (failures.length >= 5) return $t("lib.remote-control.text_d15409fa8f");
    if (!consumeRemoteOtp(root, token, now)) {
      failures.push(now);
      return $t("lib.remote-control.text_8f75e8e132");
    }
    failures = [];
  }
  async function rememberAuthorization(permission: RemoteScope, event: MessageEvent) {
    const audit = join(root, "data", "remote-auth", "operations.jsonl");
    await using file = await open(audit, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    if (!(await file.stat()).isFile()) throw new Error($t("lib.remote-control.text_296be66423"));
    await file.writeFile(JSON.stringify({
      at: new Date().toISOString(), action: permission, adapter: event.adapter ?? "onebot",
      bot: event.self_id, owner: event.user_id,
    }) + "\n");
  }
  const guide = $t("lib.remote-control.text_b1a584871b");
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
        await reply($t("lib.remote-control.text_733410d9d6"));
        return;
      }
      const image = await import("./remote-status-card.ts")
        .then(({ renderRemoteStatusCard }) => renderRemoteStatusCard(paired, enabled)).catch(() => undefined);
      if (!scope.current() || !await scope.allowed("remote.spawn") || !scope.current()) return;
      if (image && await event.reply({ type: "image", file: image.png }) !== false) return;
      await reply(paired ? $t("lib.remote-control.text_87ea3b4a00") : $t("lib.remote-control.text_6a77b2f525", { "guide": guide }));
      return;
    }

    const spawn = spawnCommand.exec(event.msg);
    const file = fileCommand.exec(event.msg);
    if ((!spawn && !file) || event.msg.length > 4_096) {
      await reply($t("lib.remote-control.text_9039061ac2"));
      return;
    }
    if (busy) {
      await reply($t("lib.remote-control.text_3a5f213b48"));
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
        await reply($t("lib.remote-control.text_57ba87e430"));
        return;
      }
      if (!isRemotePlatformSupported()) {
        await reply($t("lib.remote-control.text_665a671d49"));
        return;
      }
      if (spawn) {
        const shell = spawn[3]!.toLowerCase() as RemoteShell;
        if (!settings.shells.includes(shell)) {
          await reply($t("lib.remote-control.text_3138b0041f"));
          return;
        }
        const admin = /^(?:远程管理员|admin)/iu.test(spawn[1]!);
        if (admin && (!settings.allowAdmin || !isRemoteAdministrator())) {
          await reply($t("lib.remote-control.text_c7ce433ba0"));
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
        await reply(download ? $t("lib.remote-control.text_260f3fc164") : $t("lib.remote-control.text_7a78681c92"));
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
          await reply($t("lib.remote-control.text_daf7c02df1"));
          return;
        }
        const result = await event.uploadFile!(content);
        await reply(result === "confirmed" ? $t("lib.remote-control.text_b9c433daf5") : result === "unknown"
          ? $t("lib.remote-control.text_feb07de4c7") : $t("lib.remote-control.text_91d8812648"));
        return;
      }

      const attachment = event.attachment!;
      const bytes = await attachment.read(scope.signal);
      if (!bytes || bytes.byteLength > maxChatFileBytes ||
          (attachment.size !== undefined && attachment.size !== bytes.byteLength)) {
        await reply($t("lib.remote-control.text_8d3cefdcc6"));
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
      await reply(written ? $t("lib.remote-control.text_aa4acee215") : $t("lib.remote-control.text_ce3eeec0ef"));
    } catch {
      await reply($t("lib.remote-control.text_2c4147eb01"));
    } finally {
      busy = false;
    }
  };
}
