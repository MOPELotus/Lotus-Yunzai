import { MAX_PROFILE_ID, ProfileError, createProfileStore, parseDeviceBinding } from "@lotus-yunzai/account";
import { maxChatFileBytes } from "./chat-files.ts";
import type { CommandModule, MessageFallbackContext, CommandReply } from "./commands.ts";

const bind = /^(?:#(?:原神|星铁|绝区零)?|[#/]?zzz|#?[%％](?:绝区零|zzz)?|绝区零)绑定设备(?:信息)?([1-9]\d{0,2})?(?:\s+([\s\S]*))?$/iu;
const cancel = /^#取消绑定设备(?:信息)?([1-9]\d{0,2})?$/u;
const zzzHelp = /^(?:[#/]?(?:zzz|绝区零)(?:zzz|绝区零)?|#?[%％](?:zzz|绝区零)?)绑定设备帮助([1-9]\d{0,2})?$/iu;
const timeout = 120_000;
const apkName = "copy_device_info_1.2.apk";
const oldApk = new URL(`../data/passport/resources/apk/${apkName}`, import.meta.url);

function containsDeviceInput(message: string) {
  const id = /(?:device[_-]?id|bbs_device_id)\s*["']?\s*[:=：]/iu.test(message);
  const fp = /(?:device[_-]?fp|\bfp)\s*["']?\s*[:=：]/iu.test(message);
  return (id && fp) || (/^\s*(?:\{|\x60{3}|(?:device|bbs_device|x-rpc-device|fp)\b)/iu.test(message) && (id || fp));
}

export function isDeviceBindingInput(message: string) {
  return bind.test(message) || cancel.test(message) || zzzHelp.test(message) || containsDeviceInput(message);
}

interface BindingRequest {
  readonly profileId: number;
  readonly revision: string;
  readonly expires: number;
}

export function deviceCommands(directory: string | undefined, signal: AbortSignal,
  showProfile: (profileId: number, context: MessageFallbackContext) => Promise<CommandReply> | CommandReply): CommandModule {
  const profiles = createProfileStore(directory);
  const pending = new Map<string, BindingRequest>();
  const opening = new Map<string, { readonly profileId: number }>();
  signal.addEventListener("abort", () => {
    pending.clear();
    opening.clear();
  }, { once: true });
  return {
    name: "@lotus-yunzai/device",
    commands: {},
    async fallback(_message, context) {
      if (signal.aborted) return;
      const text = context.normalizedMessage.trim();
      const opened = bind.exec(text);
      const cancelled = cancel.exec(text);
      const help = zzzHelp.exec(text);
      const payload = containsDeviceInput(text);
      if (!opened && !cancelled && !help && !payload && text !== "取消") return;
      const { user_id, message_type, self_id, adapter } = context;
      const id = Number((opened ?? cancelled ?? help)?.[1] ?? 1);
      if (id > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      if (help) {
        if (context.isDelegated || (message_type !== "private" && message_type !== "group")) return;
        const suffix = id === 1 ? "" : id;
        return [
          `登录该档案后，私聊发送 #绑定设备${suffix}。`,
          "按提示在同一条私聊消息中发送该设备的 JSON，或配对的 device_id 和 device_fp。",
          "如收到附带的安卓设备信息工具，也可用它复制数据。等待有效期为两分钟，发送「取消」退出。",
          `绑定后可用 #设备信息${suffix} 查看。`,
        ].join("\n");
      }
      if (message_type !== "private" || !user_id || !Number.isSafeInteger(user_id) || user_id < 1 ||
          !self_id || !Number.isSafeInteger(self_id) || self_id < 1) {
        if (opened || cancelled) return `请私聊发送 #绑定设备${id === 1 ? "" : id}。`;
        return;
      }
      const qq = String(user_id);
      const scope = `${adapter ?? "onebot"}:${self_id}:${qq}`;
      if (cancelled || text === "取消") {
        const waiting = pending.get(scope) ?? opening.get(scope);
        if (!waiting || (cancelled?.[1] !== undefined && waiting.profileId !== id)) {
          return cancelled ? "当前私聊没有该档案的设备绑定等待。" : undefined;
        }
        pending.delete(scope);
        opening.delete(scope);
        return "已取消绑定设备。";
      }

      let request = pending.get(scope);
      if (opened) {
        pending.delete(scope);
        const attempt = { profileId: id };
        opening.set(scope, attempt);
        try {
          const account = await profiles.accountContext(qq, id);
          if (opening.get(scope) !== attempt) return [];
          request = { profileId: id, revision: account.revision, expires: performance.now() + timeout };
        } catch {
          if (opening.get(scope) !== attempt) return [];
          return `[account] 请先扫码登录 profile ${id}。`;
        } finally {
          if (opening.get(scope) === attempt) opening.delete(scope);
        }
        if (!opened[2]?.trim()) {
          const current = request;
          pending.set(scope, current);
          setTimeout(() => {
            if (pending.get(scope) === current) pending.delete(scope);
          }, timeout).unref();
          const prompt = `请发送 profile ${id} 的设备 JSON，或同一份 device_id 和 device_fp。发送「取消」可退出，两分钟内有效。`;
          if (await context.reply(prompt) === false || signal.aborted) {
            if (pending.get(scope) === current) pending.delete(scope);
            return [];
          }
          const file = Bun.file(Bun.env.LOTUS_DEVICE_INFO_APK?.trim() || oldApk);
          if (context.uploadFile && await file.exists() && file.size > 0 && file.size <= maxChatFileBytes) {
            const bytes = await file.bytes().catch(() => undefined);
            if (!signal.aborted && bytes && pending.get(scope) === current) {
              await context.uploadFile({ name: apkName, bytes }).catch(() => undefined);
            }
          }
          return [];
        }
      }
      if (!request) return "请先私聊发送 #绑定设备。";
      if (request.expires <= performance.now()) {
        pending.delete(scope);
        return "设备绑定等待已超时，请重新发送 #绑定设备。";
      }
      try {
        const device = parseDeviceBinding(opened?.[2] ?? text);
        pending.delete(scope);
        await profiles.saveBoundDevice(qq, request.profileId, request.revision, device, signal);
        if (signal.aborted) return [];
      } catch (error) {
        if (signal.aborted) return [];
        if (error instanceof ProfileError && error.code === "changed") return "档案已变化，请重新发起设备绑定。";
        return "设备绑定未完成，请在同一份信息中提供匹配的设备 ID 和 FP。";
      }
      try {
        return await showProfile(request.profileId, context);
      } catch {
        return `[account] profile ${request.profileId} 设备已绑定。`;
      }
    },
  };
}
