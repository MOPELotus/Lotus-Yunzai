import { MAX_PROFILE_ID, ProfileError, createProfileStore, parseDeviceBinding, type ProfileAccountContext } from "@lotus-yunzai/account";
import { maxChatFileBytes } from "./chat-files.ts";
import type { CommandModule, MessageFallbackContext, CommandReply } from "./commands.ts";

const zzzDevicePrefix = "(?:#?[%％](?:绝区零|zzz)?|[#/](?:绝区零|zzz)(?:绝区零|zzz)?|绝区零|zzz)";
const bindPrefix = "(?:#(?:原神|星铁)?|" + zzzDevicePrefix + ")";
const bind = new RegExp(`^${bindPrefix}绑定设备(?:信息)?([1-9]\\d{0,2})?(?:\\s+([\\s\\S]*))?$`, "iu");
const view = new RegExp(`^${bindPrefix}(设备信息(?:[1-9]\\d{0,2})?)$`, "iu");
const cancel = /^#取消绑定设备(?:信息)?([1-9]\d{0,2})?$/u;
const unbind = /^(?:#(?:绝区零)?|[#/]?zzz|#?[%％](?:绝区零|zzz)?|绝区零)解绑设备(?:信息)?([1-9]\d{0,2})?$/iu;
const zzzHelp = /^(?:[#/]?(?:zzz|绝区零)(?:zzz|绝区零)?|#?[%％](?:zzz|绝区零)?)绑定设备帮助([1-9]\d{0,2})?$/iu;
const timeout = 120_000;
const apkName = "copy_device_info_1.2.apk";
const bundledApk = new URL(`../resources/device-binding/${apkName}`, import.meta.url);
const oldApk = new URL(`../data/passport/resources/apk/${apkName}`, import.meta.url);
const apkDownload = `https://raw.githubusercontent.com/MOPELotus/Lotus-ReFactor/29f040c9021462eebf6ed74a9bd9a383c61b7039/resources/apk/${apkName}`;
const apkFallback = `可继续发送设备 JSON。需要工具时，可直接下载：\n${apkDownload}`;

const legacyDeviceMetadataFields = ["deviceBoard", "deviceFingerprint", "deviceModel", "deviceName", "deviceProduct"]
  .map(field => new RegExp(`"${field}"\\s*:`, "u"));

function containsLegacyDeviceMetadata(message: string): boolean {
  return legacyDeviceMetadataFields.every(field => field.test(message));
}

function containsDeviceInput(message: string) {
  const id = /(?:device[_-]?id|bbs_device_id)\s*["']?\s*[:=：]/iu.test(message);
  const fp = /(?:device[_-]?fp|\bfp)\s*["']?\s*[:=：]/iu.test(message);
  return (id && fp) || (/^\s*(?:\{|\x60{3}|(?:device|bbs_device|x-rpc-device|fp)\b)/iu.test(message) && (id || fp));
}

export function normalizeDeviceInfoCommand(message: string) {
  return message.replace(view, "#$1");
}

export function isDeviceBindingInput(message: string) {
  return bind.test(message) || cancel.test(message) || unbind.test(message) || zzzHelp.test(message) ||
    isDeviceBindingPayload(message);
}

export function isDeviceBindingPayload(message: string) {
  return containsDeviceInput(message) || containsLegacyDeviceMetadata(message);
}

interface BindingRequest {
  readonly profileId: number;
  readonly connection: AbortSignal;
  readonly operation: AbortController;
  snapshot?: { readonly account: ProfileAccountContext; readonly expires: number };
  writing?: true;
}

export function deviceCommands(directory: string | undefined, signal: AbortSignal,
  showProfile: (profileId: number, context: MessageFallbackContext) => Promise<CommandReply> | CommandReply,
  apk?: string | URL,
): CommandModule {
  const profiles = createProfileStore(directory);
  const pending = new Map<string, BindingRequest>();
  signal.addEventListener("abort", () => pending.clear(), { once: true });

  function cancelRequest(scope: string, request: BindingRequest) {
    if (pending.get(scope) !== request) return;
    pending.delete(scope);
    request.operation.abort();
  }
  return {
    name: "@lotus-yunzai/device",
    commands: {},
    async fallback(_message, context) {
      if (signal.aborted) return;
      const text = context.normalizedMessage.trim();
      const opened = bind.exec(text);
      const cancelled = cancel.exec(text);
      const unbound = unbind.exec(text);
      const help = zzzHelp.exec(text);
      const payload = containsDeviceInput(text);
      const legacyMetadata = !payload && containsLegacyDeviceMetadata(text);
      if (!opened && !cancelled && !unbound && !help && !payload && !legacyMetadata && text !== "取消") return;
      const { user_id, message_type, self_id, adapter } = context;
      const id = Number((opened ?? cancelled ?? unbound ?? help)?.[1] ?? 1);
      if (id > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      if (help) {
        if (context.isDelegated || (message_type !== "private" && message_type !== "group")) return;
        const suffix = id === 1 ? "" : id;
        return [
          `加机器人好友并登录该档案后，好友私聊发送 #绑定设备${suffix}。`,
          "按提示在同一条私聊消息中发送该设备的 JSON，或配对的 device_id 和 device_fp。",
          "旧安卓工具可能只复制设备参数，绑定仍需配对的 ID 和已签发的 FP。等待有效期为两分钟，发送「取消」退出。",
          `绑定后可用 #设备信息${suffix} 查看。`,
        ].join("\n");
      }
      if (message_type !== "private" || !user_id || !Number.isSafeInteger(user_id) || user_id < 1 ||
          !self_id || !Number.isSafeInteger(self_id) || self_id < 1) {
        if (unbound && !context.isDelegated) return "请在本人私聊中解绑设备。";
        if (opened || cancelled) return `请先加机器人好友，再在好友私聊发送 #绑定设备${id === 1 ? "" : id}。设备资料请只发在好友私聊。`;
        return;
      }
      const qq = String(user_id);
      const scope = `${adapter ?? "onebot"}:${self_id}:${qq}`;
      const connection = context.privateCredentialSignal;
      if (context.isDelegated || connection?.aborted) return;
      if (!connection) {
        if (opened && !opened[2]) return "请先加机器人好友，再在好友私聊发起设备绑定。";
        return;
      }
      const active = AbortSignal.any([signal, connection]);
      if (legacyMetadata) return "这份 JSON 只有设备参数。请在本人私聊提供同一设备的 device_id 和已签发的 device_fp。";
      if (unbound) {
        const waiting = pending.get(scope);
        if (waiting?.profileId === id) cancelRequest(scope, waiting);
        try {
          const current = await profiles.accountContext(qq, id);
          const removed = await profiles.removeBoundDevice(qq, id, current.revision, active);
          if (active.aborted) return;
          return removed ? "已解绑该档案的设备。" : "该档案没有已绑定的设备。";
        } catch (error) {
          if (active.aborted) return;
          if (error instanceof ProfileError && error.code === "changed") return "档案已变化，请重新发送解绑指令。";
          return "暂时无法解绑该档案的设备，请确认已登录并稍后重试。";
        }
      }
      if (cancelled || text === "取消") {
        const waiting = pending.get(scope);
        if (!waiting || waiting.connection !== connection || (cancelled?.[1] !== undefined && waiting.profileId !== id)) {
          return cancelled ? "当前私聊没有该档案的设备绑定等待。" : undefined;
        }
        cancelRequest(scope, waiting);
        return "已取消绑定设备。";
      }

      const waiting = pending.get(scope);
      let request = waiting?.connection === connection ? waiting : undefined;
      if (opened) {
        if (waiting) cancelRequest(scope, waiting);
        const current: BindingRequest = { profileId: id, connection, operation: new AbortController() };
        request = current;
        pending.set(scope, current);
        const isCurrent = () => !active.aborted && pending.get(scope) === current;
        try {
          const account = await profiles.accountContext(qq, id);
          if (!isCurrent()) {
            cancelRequest(scope, current);
            return [];
          }
          current.snapshot = { account, expires: performance.now() + timeout };
        } catch {
          const report = isCurrent();
          cancelRequest(scope, current);
          if (!report) return [];
          return `[account] 请先扫码登录 profile ${id}。`;
        }
        if (!opened[2]?.trim()) {
          setTimeout(() => {
            if (!current.writing) cancelRequest(scope, current);
          }, timeout).unref();
          const prompt = `请发送 profile ${id} 的设备 JSON，或同一设备的 device_id 和 device_fp。旧工具只有安卓参数时，还需要这两个字段。发送「取消」可退出，两分钟内有效。`;
          if (await context.reply(prompt) === false || active.aborted) {
            if (pending.get(scope) === current) pending.delete(scope);
            return [];
          }
          if (!isCurrent() || current.writing) return [];
          if (!context.uploadFile) return `当前连接无法发送附件。${apkFallback}`;
          let bytes: Uint8Array | undefined;
          const override = apk ?? Bun.env.LOTUS_DEVICE_INFO_APK?.trim();
          for (const location of override ? [override] : [bundledApk, oldApk]) {
            try {
              const file = Bun.file(location);
              if (!await file.exists() || file.size <= 0 || file.size > maxChatFileBytes) continue;
              const candidate = await file.slice(0, maxChatFileBytes + 1).bytes();
              if (!candidate.byteLength || candidate.byteLength > maxChatFileBytes) continue;
              bytes = candidate;
              break;
            } catch {
              // The download link remains available if local copies cannot be read.
            }
          }
          if (!isCurrent() || current.writing) return [];
          if (!bytes?.byteLength || bytes.byteLength > maxChatFileBytes) return `设备信息工具文件暂不可用。${apkFallback}`;
          const outcome = await context.uploadFile({ name: apkName, bytes }).catch(() => "unknown");
          return isCurrent() && outcome === "rejected" ? `设备信息工具未能发送。${apkFallback}` : [];
        }
      }
      if (!request?.snapshot || request.writing) return "请先私聊发送 #绑定设备。";
      if (request.snapshot.expires <= performance.now()) {
        cancelRequest(scope, request);
        return "设备绑定等待已超时，请重新发送 #绑定设备。";
      }
      const writeSignal = AbortSignal.any([active, request.operation.signal]);
      try {
        const device = parseDeviceBinding(opened?.[2] ?? text);
        request.writing = true;
        await profiles.saveBoundDevice(qq, request.profileId, request.snapshot.account, device, writeSignal);
        if (writeSignal.aborted) return [];
      } catch (error) {
        if (writeSignal.aborted) return [];
        if (error instanceof ProfileError && error.code === "changed") return "档案已变化，请重新发起设备绑定。";
        if (error instanceof ProfileError && error.code === "invalid") return error.message;
        return "设备绑定未完成，请在同一份信息中提供匹配的设备 ID 和 FP。";
      } finally {
        if ((opened || request.writing) && pending.get(scope) === request) pending.delete(scope);
      }
      try {
        await context.reply("设备已绑定。设备资料是你发的私聊消息，请在 QQ 中自行撤回刚才那条消息。");
      } catch {
        // Binding is already saved even if the cleanup reminder cannot be delivered.
      }
      try {
        return await showProfile(request.profileId, context);
      } catch {
        return `[account] profile ${request.profileId} 设备已绑定。`;
      }
    },
  };
}
