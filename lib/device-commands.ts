import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { DeviceFingerprintError, requestDeviceFingerprint } from "@lotus-yunzai/hoyo-client";
import type { HoyoTransport } from "@lotus-yunzai/hoyo-client";
import { MAX_PROFILE_ID, ProfileError, createProfileStore, parseDeviceBinding, parseAndroidDeviceInfo, type ProfileAccountContext } from "@lotus-yunzai/account";
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
const apkFallback = $t("lib.device-commands.text_dce8c9281f", { "apkDownload": apkDownload });

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
  options: { readonly transport?: HoyoTransport } = {},
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
      if (id > MAX_PROFILE_ID) return $t("lib.device-commands.text_3dd62228d2");
      if (help) {
        if (context.isDelegated || (message_type !== "private" && message_type !== "group")) return;
        const suffix = id === 1 ? "" : id;
        return [
          $t("lib.device-commands.text_fc98247ef3", { "suffix": suffix }),
          $t("lib.device-commands.text_4163fc063d"),
          $t("lib.device-commands.text_3468a4588e"),
          $t("lib.device-commands.text_c5b7b89c39", { "suffix": suffix }),
        ].join("\n");
      }
      if (message_type !== "private" || !user_id || !Number.isSafeInteger(user_id) || user_id < 1 ||
          !self_id || !Number.isSafeInteger(self_id) || self_id < 1) {
        if (unbound && !context.isDelegated) return $t("lib.device-commands.text_e99ac1feff");
        if (opened || cancelled) return $t("lib.device-commands.text_68b51087b3", { "value1": id === 1 ? "" : id });
        return;
      }
      const qq = String(user_id);
      const scope = `${adapter ?? "onebot"}:${self_id}:${qq}`;
      const connection = context.privateCredentialSignal;
      if (context.isDelegated || connection?.aborted) return;
      if (!connection) {
        if (opened && !opened[2]) return $t("lib.device-commands.text_534d8303ef");
        return;
      }
      const active = AbortSignal.any([signal, connection]);
      if (unbound) {
        const waiting = pending.get(scope);
        if (waiting?.profileId === id) cancelRequest(scope, waiting);
        try {
          const current = await profiles.accountContext(qq, id);
          const removed = await profiles.removeBoundDevice(qq, id, current.revision, active);
          if (active.aborted) return;
          return removed ? $t("lib.device-commands.text_a532eb4dc3") : $t("lib.device-commands.text_7186b0924f");
        } catch (error) {
          if (active.aborted) return;
          if (error instanceof ProfileError && error.code === "changed") return $t("lib.device-commands.text_cedbf8227c");
          return $t("lib.device-commands.text_7e161ca2dc");
        }
      }
      if (cancelled || text === "取消") {
        const waiting = pending.get(scope);
        if (!waiting || waiting.connection !== connection || (cancelled?.[1] !== undefined && waiting.profileId !== id)) {
          return cancelled ? $t("lib.device-commands.text_d996b42581") : undefined;
        }
        cancelRequest(scope, waiting);
        return $t("lib.device-commands.text_82309eac71");
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
          return $t("lib.device-commands.text_5c992b438d", { "id": id });
        }
        if (!opened[2]?.trim()) {
          setTimeout(() => {
            if (!current.writing) cancelRequest(scope, current);
          }, timeout).unref();
          const prompt = $t("lib.device-commands.text_8085c78af1", { "id": id });
          if (await context.reply(prompt) === false || active.aborted) {
            if (pending.get(scope) === current) pending.delete(scope);
            return [];
          }
          if (!isCurrent() || current.writing) return [];
          if (!context.uploadFile) return $t("lib.device-commands.text_174838b9f6", { "apkFallback": apkFallback });
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
          if (!bytes?.byteLength || bytes.byteLength > maxChatFileBytes) return $t("lib.device-commands.text_fd690683f9", { "apkFallback": apkFallback });
          const outcome = await context.uploadFile({ name: apkName, bytes }).catch(() => "unknown");
          return isCurrent() && outcome === "rejected" ? $t("lib.device-commands.text_2c7bf9448a", { "apkFallback": apkFallback }) : [];
        }
      }
      if (!request?.snapshot || request.writing) return $t("lib.device-commands.text_28c979db41");
      if (request.snapshot.expires <= performance.now()) {
        cancelRequest(scope, request);
        return $t("lib.device-commands.text_e4cfc3641a");
      }
      const writeSignal = AbortSignal.any([active, request.operation.signal]);
      try {
        const input = opened?.[2] ?? text;
        const android = parseAndroidDeviceInfo(input);
        const direct = android ? undefined : parseDeviceBinding(input);
        request.writing = true;
        const target = request;
        const device = direct ?? await requestDeviceFingerprint(android!, {
          transport: options.transport, signal: writeSignal,
          verify: () => profiles.verifyDeviceBindingTarget(qq, target.profileId, target.snapshot!.account),
        });
        await profiles.saveBoundDevice(qq, request.profileId, request.snapshot.account, device, writeSignal);
        if (writeSignal.aborted) return [];
      } catch (error) {
        if (writeSignal.aborted) return [];
        if (error instanceof ProfileError && error.code === "changed") return $t("lib.device-commands.text_d02867269e");
        if (error instanceof ProfileError && error.code === "invalid") return error.message;
        if (error instanceof DeviceFingerprintError || error instanceof TypeError) return error.message;
        return $t("lib.device-commands.text_2d056c1e65");
      } finally {
        if ((opened || request.writing) && pending.get(scope) === request) pending.delete(scope);
      }
      try {
        await context.reply($t("lib.device-commands.text_25b7a89b0a"));
      } catch {
        // Binding is already saved even if the cleanup reminder cannot be delivered.
      }
      try {
        return await showProfile(request.profileId, context);
      } catch {
        return $t("lib.device-commands.text_8b01dcf8ff", { "profileId": request.profileId });
      }
    },
  };
}
