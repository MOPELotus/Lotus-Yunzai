import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
      if (!matched) return password.test(command) ? $t("lib.passport-login.text_e2dd9bb438") : undefined;
      const profileId = Number(matched[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return $t("lib.passport-login.text_3dd62228d2");
      const { user_id, self_id, adapter, privateCredentialSignal: connection } = context;
      const commandForProfile = `#扫码登录${profileId === 1 ? "" : profileId}`;
      if (context.message_type !== "private" || !validId(user_id) || !validId(self_id)) {
        return $t("lib.passport-login.text_7fd1c4df47", { "commandForProfile": commandForProfile });
      }
      if (!connection || connection.aborted || context.isDelegated) {
        return $t("lib.passport-login.text_f6522654a3");
      }
      const qq = String(user_id);
      const scope = `${adapter ?? "onebot"}/${self_id}/${qq}`;
      const key = `${qq}/${profileId}`;
      const existing = active.get(key);
      if (cancellation) {
        if (existing?.scope !== scope) return $t("lib.passport-login.text_b25088e14e");
        if (existing.saving) return $t("lib.passport-login.text_f7b59fea5f");
        existing.cancel.abort();
        return $t("lib.passport-login.text_4fa98861ab");
      }
      if (existing) return $t("lib.passport-login.text_48e0a95bbd");

      const session: LoginSession = { scope, cancel: new AbortController(), saving: false };
      active.set(key, session);
      const deadlineSignal = AbortSignal.any([signal, connection, session.cancel.signal]);
      try {
        const slot = await profiles.openLoginSlot(qq, profileId);
        if (await context.reply($t("lib.passport-login.text_fca3f02765", { "profileId": profileId })) === false) return [];
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
            throw new ProfileError("changed", $t("lib.passport-login.text_bc83f6a127"));
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
        if (Date.now() >= expires) return $t("lib.passport-login.text_2cceaa95f0");
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
              await context.reply($t("lib.passport-login.text_8318c1c445"));
            } catch {
              // The confirmation can continue while the original friend session is active.
              deadlineSignal.throwIfAborted();
            }
          }
          if (result.status === "expired") break;
          if (result.status === "cancelled") return $t("lib.passport-login.text_ace2f0d792");
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
          return rolesSynced ? $t("lib.passport-login.text_27f414f451", { "profileId": profileId })
            : $t("lib.passport-login.text_c5c0b398fb", { "profileId": profileId, "value2": profileId === 1 ? "" : profileId });
        }
        return $t("lib.passport-login.text_2cceaa95f0");
      } catch (error) {
        if (deadlineSignal.aborted) return [];
        if (error instanceof HoyoRequestError) {
          const code = error.retcode === undefined ? error.status && error.status >= 400 ? `HTTP ${error.status}` : undefined
            : $t("lib.passport-login.text_54d9a57677", { "retcode": error.retcode });
          return code ? `${error.message}（${code}）` : error.message;
        }
        if (error instanceof ProfileError) return error.message;
        return $t("lib.passport-login.text_202e494e8b");
      } finally {
        if (active.get(key) === session) active.delete(key);
      }
    },
  };
}
