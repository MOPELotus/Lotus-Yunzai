import { setTimeout as wait } from "node:timers/promises";
import { createProfileStore, MAX_PROFILE_ID, ProfileError, type ProfileAccountContext } from "@lotus-yunzai/account";
import { createCredentialExchange, createHoyoClient, createPassportQr, createProfileHoyoClient, HoyoRequestError,
  isCookieExpired } from "@lotus-yunzai/hoyo-client";
import { markGeneratedImage } from "@lotus-yunzai/skia/generated-image";
import { checkinSettingsNickname } from "./checkin-profile-commands.ts";
import type { CommandModule } from "./commands.ts";

const start = /^(?:#(?:扫码|二维码|辅助)(?:登录|绑定|登陆)|#?(?:米哈?游社?登[录陆入]|登[录陆入]米哈?游社?))([1-9]\d{0,2})?$/u;
const cancel = /^#取消(?:扫码|二维码)(?:登录|绑定|登陆)([1-9]\d{0,2})?$/u;
const password = /^#?(?:(?:账号密码|密码)登[录陆][\s\S]*|(?:米哈?游社?登[录陆入]|登[录陆入]米哈?游社?)[\s\S]+)$/u;
const pollIntervalMs = 5_000;
const lifetimeMs = 5 * 60_000;

export function isPassportLoginInput(message: string) {
  return start.test(message) || cancel.test(message) || password.test(message);
}

const validId = (id?: number): id is number => id !== undefined && Number.isSafeInteger(id) && id > 0;

interface LoginSession {
  readonly scope: string;
  readonly cancel: AbortController;
  saving: boolean;
}

export function passportLoginCommands(directory: string | undefined, signal: AbortSignal,
  addLateSchedule?: (qq: string, profileId: number, revision: string) => Promise<void>,
): CommandModule {
  const profiles = createProfileStore(directory);
  const qr = createPassportQr(fetch);
  const exchange = createCredentialExchange(fetch);
  const roles = createHoyoClient(fetch);
  const signedIn = createProfileHoyoClient(profiles);
  const active = new Map<string, LoginSession>();

  return {
    name: "@lotus-yunzai/passport-login",
    commands: {},
    async fallback(_message, context) {
      const command = context.normalizedMessage;
      if (signal.aborted) return;
      const cancellation = cancel.exec(command);
      const matched = cancellation ?? start.exec(command);
      if (!matched) return password.test(command) ? "请使用 #扫码登录，账号密码登录已停用。" : undefined;
      const profileId = Number(matched[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      const { user_id, self_id, adapter, privateCredentialSignal: connection } = context;
      const commandForProfile = `#扫码登录${profileId === 1 ? "" : profileId}`;
      if (context.message_type !== "private" || !validId(user_id) || !validId(self_id)) {
        return `请私聊发送 ${commandForProfile}。`;
      }
      if (!connection || connection.aborted || context.isDelegated) {
        return "请从当前连接的机器人好友私聊发起或取消扫码登录。";
      }
      const qq = String(user_id);
      const scope = `${adapter ?? "onebot"}/${self_id}/${qq}`;
      const key = `${qq}/${profileId}`;
      const existing = active.get(key);
      if (cancellation) {
        if (existing?.scope !== scope) return "当前私聊没有该档案的扫码等待。";
        if (existing.saving) return "扫码已确认，档案正在保存。";
        existing.cancel.abort();
        return "已取消扫码登录。";
      }
      if (existing) return "该档案已有二维码等待确认，请稍后再试。";

      const session: LoginSession = { scope, cancel: new AbortController(), saving: false };
      active.set(key, session);
      const deadlineSignal = AbortSignal.any([signal, connection, session.cancel.signal]);
      try {
        const slot = await profiles.openLoginSlot(qq, profileId);
        if (await context.reply(`正在生成米游社登录二维码（档案 ${profileId}）。`) === false) return [];
        async function verifyProfile() {
          deadlineSignal.throwIfAborted();
          await profiles.verifyLoginSlot(slot);
          deadlineSignal.throwIfAborted();
        }
        async function savedProfile(revision: string) {
          deadlineSignal.throwIfAborted();
          const current = await profiles.accountContext(qq, profileId).catch(() => undefined);
          deadlineSignal.throwIfAborted();
          if (current?.revision !== revision) {
            throw new ProfileError("changed", "登录档案已变更，请重新发起扫码登录。");
          }
          return current;
        }
        await verifyProfile();
        const created = await qr.create(slot.device, { signal: deadlineSignal });
        const expires = Math.min(Date.now() + lifetimeMs, created.expiresAt ?? Infinity);
        const { default: QRCode } = await import("qrcode");
        const qrPng = await QRCode.toBuffer(created.url, { margin: 1, scale: 10, errorCorrectionLevel: "M" });
        const { renderPassportQrCard } = await import("@lotus-yunzai/skia/passport-qr");
        const timestamp = new Date().toLocaleString("sv-SE", { hour12: false });
        const card = await renderPassportQrCard({ profileId, qrPng, generatedAt: timestamp }, {
          resourceDirectory: Bun.env.LOTUS_PASSPORT_QR_RESOURCES || undefined,
        }).catch(() => undefined);
        await verifyProfile();
        if (Date.now() >= expires) return "登录二维码已过期，请重新发送扫码指令。";
        let delivered = false;
        const accepted = await context.reply({ type: "image", file: card?.png ?? markGeneratedImage(qrPng) }, false, {
          onDelivered: () => { delivered = true; },
        });
        if (!accepted || !delivered) return [];

        let scanned = false;
        while (Date.now() < expires) {
          await wait(Math.min(pollIntervalMs, expires - Date.now()), undefined, { signal: deadlineSignal });
          if (Date.now() >= expires) break;
          await verifyProfile();
          const result = await qr.poll(created, { signal: deadlineSignal });
          if (Date.now() >= expires) break;
          if (result.status === "scanned" && !scanned) {
            scanned = true;
            try {
              await context.reply("二维码已扫描，请在米游社 App 内确认登录。");
            } catch {
              // The confirmation can continue while the original friend session is active.
              deadlineSignal.throwIfAborted();
            }
          }
          if (result.status === "expired") break;
          if (result.status === "cancelled") return "已在米游社 App 取消扫码登录。";
          if (result.status !== "confirmed") continue;

          const { stuid, stoken, mid = "" } = result.credentials;
          const temporary: ProfileAccountContext = {
            qq, profileId, device: slot.device, revision: slot.revision ?? "",
            account: { stuid, ltuid: stuid, stoken, mid, cookie: "", stokenCookie: "", ltoken: "" },
          };
          const credentials = await exchange(temporary, { signal: deadlineSignal, verifyProfile });
          const first = await roles.fetchRoleCatalog(
            { ...temporary, account: { ...temporary.account, cookie: credentials.cookie } }, deadlineSignal,
          ).then(roles => ({ roles, retry: undefined }), (error: unknown) => ({
            roles: undefined,
            retry: isCookieExpired(error) ? "refresh" : error instanceof HoyoRequestError &&
              (error.code === "transport" || error.code === "response" ||
                (error.code === "http" && (error.status === 410 || (error.status ?? 0) >= 500))) ? "read" : undefined,
          }));
          await verifyProfile();
          session.saving = true;
          const saved = await profiles.saveLogin(slot, {
            stuid, stoken, mid, credentials, roles: first.roles, nickname: checkinSettingsNickname(context),
          }, deadlineSignal);
          let { rolesSynced, revision } = saved;
          if (first.retry && !deadlineSignal.aborted) {
            try {
              const current = await savedProfile(revision);
              if (first.retry === "refresh") {
                const refreshed = await signedIn.refreshProfile(current, deadlineSignal);
                rolesSynced = refreshed.rolesSynced;
                if (refreshed.revision !== undefined) revision = refreshed.revision;
              } else {
                const directory = await roles.fetchRoleCatalog(current, deadlineSignal);
                deadlineSignal.throwIfAborted();
                revision = (await profiles.saveRoles(qq, profileId, revision, directory)).revision;
                rolesSynced = true;
              }
            } catch {
              // The confirmed login remains usable even when its roles cannot be synchronized.
            }
          }
          if (addLateSchedule) {
            await savedProfile(revision);
            await addLateSchedule(qq, profileId, revision).catch(() => undefined);
          }
          await savedProfile(revision);
          return rolesSynced ? `档案 ${profileId} 扫码登录完成。`
            : `档案 ${profileId} 登录信息已保存，角色暂未同步，可用 #同步角色${profileId === 1 ? "" : profileId} 重试。`;
        }
        return "登录二维码已过期，请重新发送扫码指令。";
      } catch (error) {
        if (deadlineSignal.aborted) return [];
        if (error instanceof HoyoRequestError) {
          const code = error.retcode === undefined ? error.status && error.status >= 400 ? `HTTP ${error.status}` : undefined
            : `错误码 ${error.retcode}`;
          return code ? `${error.message}（${code}）` : error.message;
        }
        if (error instanceof ProfileError) return error.message;
        return "扫码登录未完成，请稍后重试。";
      } finally {
        if (active.get(key) === session) active.delete(key);
      }
    },
  };
}
