import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { HoyoRequestError, verifyHoYoLabCookie } from "@lotus-yunzai/hoyo-client";
import type { CommandContext, CommandModule, CommandReply } from "./commands.ts";

const cookieInput = /^\s*[#＃井/]\s*绑定\s*(?:国际服|海外服)\s*cookie/iu;
const cookieBinding = /^\s*[#＃井/]\s*绑定\s*(?:国际服|海外服)\s*cookie([0-9]*)\s+([^\r\n]+)$/iu;
const toggle = /^#(启用|开启|关闭|禁用)(?:国际服|海外服)(?:签到)?([0-9]*)$/u;
const language = /^#设置(?:国际服|海外服)语言([0-9]*)\s+([A-Za-z_-]{1,32})$/u;

export function isHoYoLabCookieInput(raw: string): boolean {
  return cookieInput.test(raw);
}

export function hoyoLabProfileCommands(directory: string | undefined, signal: AbortSignal, {
  viewProfile, verifyCookie = verifyHoYoLabCookie, transport = fetch,
}: {
  readonly viewProfile: (profileId: number, context: CommandContext) => CommandReply | Promise<CommandReply>;
  readonly verifyCookie?: typeof verifyHoYoLabCookie;
  readonly transport?: Parameters<typeof verifyHoYoLabCookie>[1];
}): CommandModule {
  const profiles = createProfileStore(directory);

  async function bindCookie(message: string, context: CommandContext) {
    if (context.message_type !== "private") return $t("lib.hoyolab-profile-commands.text_7aef9938a8");
    const match = cookieBinding.exec(message);
    if (!match) return $t("lib.hoyolab-profile-commands.text_dbc8aed881");
    const suffix = match[1] ?? "";
    const id = Number(suffix || 1);
    if ((suffix && !/^[1-9]\d{0,2}$/u.test(suffix)) || id > MAX_PROFILE_ID) return $t("lib.hoyolab-profile-commands.text_3dd62228d2");
    const { privateCredentialSignal: session, user_id: user } = context;
    if (!session || session.aborted || user === undefined || !Number.isSafeInteger(user) || user < 1) {
      return $t("lib.hoyolab-profile-commands.text_1c30c48efa");
    }
    const scoped = AbortSignal.any([signal, session]);
    const qq = String(user);
    let saved = false;
    try {
      const current = await profiles.checkinSettings(qq, id);
      if (!current.loggedIn) return $t("lib.hoyolab-profile-commands.text_62b08191fe", { "id": id });
      async function verifyProfile() {
        scoped.throwIfAborted();
        const latest = await profiles.checkinSettings(qq, id).catch(() => undefined);
        if (!latest?.loggedIn || latest.revision !== current.revision) throw new ProfileError("changed", $t("lib.hoyolab-profile-commands.text_8a1edc5158"));
        scoped.throwIfAborted();
      }
      await verifyProfile();
      const verified = await verifyCookie(match[2]!, transport, { signal: scoped, verifyProfile });
      await verifyProfile();
      await profiles.saveInternationalCookie(qq, id, current.revision, verified, scoped);
      saved = true;
      if (!scoped.aborted) return await viewProfile(id, context);
    } catch (error) {
      if (scoped.aborted) return;
      if (saved) return $t("lib.hoyolab-profile-commands.text_33ac99d56c", { "id": id });
      if (error instanceof ProfileError) {
        if (error.code === "missing" || error.code === "login-required") return $t("lib.hoyolab-profile-commands.text_62b08191fe", { "id": id });
        if (error.code === "changed") return $t("lib.hoyolab-profile-commands.text_7ecefd0f09");
      }
      if (error instanceof HoyoRequestError && error.code === "invalid-input") return $t("lib.hoyolab-profile-commands.text_5ca048764d");
      return $t("lib.hoyolab-profile-commands.text_e886426f89");
    }
  }

  return {
    name: "@lotus-yunzai/hoyolab-profile",
    commands: {},
    async fallback(_message, context) {
      if (signal.aborted) return;
      const message = context.normalizedMessage;
      if (isHoYoLabCookieInput(message) || isHoYoLabCookieInput(context.raw_message ?? "")) {
        return bindCookie(message, context);
      }

      const sign = toggle.exec(message);
      const locale = language.exec(message);
      if (!sign && !locale) return;
      const suffix = sign?.[2] ?? locale?.[1] ?? "";
      const id = Number(suffix || 1);
      if ((suffix && !/^[1-9]\d{0,2}$/u.test(suffix)) || id > MAX_PROFILE_ID) return $t("lib.hoyolab-profile-commands.text_3dd62228d2");
      const user = context.user_id;
      if (user === undefined || !Number.isSafeInteger(user) || user < 1 || context.message_type === "terminal") {
        return $t("lib.hoyolab-profile-commands.text_002224d14a");
      }

      const qq = String(user);
      let saved = false;
      try {
        const current = await profiles.checkinSettings(qq, id);
        if (signal.aborted) return;
        if (!current.loggedIn) return $t("lib.hoyolab-profile-commands.text_62b08191fe", { "id": id });
        await profiles.setProfileCheckinSettings(qq, id, current.revision, sign
          ? { type: "international", enabled: sign[1] === "启用" || sign[1] === "开启" }
          : { type: "international-language", language: locale![2]! });
        saved = true;
        if (signal.aborted) return;
        return await viewProfile(id, context);
      } catch (error) {
        if (signal.aborted) return;
        if (saved) return $t("lib.hoyolab-profile-commands.text_0085b5fd55", { "id": id });
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") return $t("lib.hoyolab-profile-commands.text_62b08191fe", { "id": id });
          if (error.code === "changed") return $t("lib.hoyolab-profile-commands.text_3ddebc59b1");
        }
        return $t("lib.hoyolab-profile-commands.text_2860d30205");
      }
    },
  };
}
