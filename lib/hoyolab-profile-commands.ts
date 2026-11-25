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
    if (context.message_type !== "private") return "请在私聊中绑定国际服 Cookie。";
    const match = cookieBinding.exec(message);
    if (!match) return "请发送 #绑定国际服Cookie 加空格和 Cookie，可在指令后加档案编号。";
    const suffix = match[1] ?? "";
    const id = Number(suffix || 1);
    if ((suffix && !/^[1-9]\d{0,2}$/u.test(suffix)) || id > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
    const { privateCredentialSignal: session, user_id: user } = context;
    if (!session || session.aborted || user === undefined || !Number.isSafeInteger(user) || user < 1) {
      return "请从当前连接的机器人好友私聊绑定国际服 Cookie。";
    }
    const scoped = AbortSignal.any([signal, session]);
    const qq = String(user);
    let saved = false;
    try {
      const current = await profiles.checkinSettings(qq, id);
      if (!current.loggedIn) return `请先登录档案 ${id}。`;
      async function verifyProfile() {
        scoped.throwIfAborted();
        const latest = await profiles.checkinSettings(qq, id).catch(() => undefined);
        if (!latest?.loggedIn || latest.revision !== current.revision) throw new ProfileError("changed", "档案已变更。");
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
      if (saved) return `档案 ${id} 的国际服 Cookie 已绑定，暂时无法显示资料卡。`;
      if (error instanceof ProfileError) {
        if (error.code === "missing" || error.code === "login-required") return `请先登录档案 ${id}。`;
        if (error.code === "changed") return "档案已变更，请重新绑定国际服 Cookie。";
      }
      if (error instanceof HoyoRequestError && error.code === "invalid-input") return "请输入归属一致的国际服 Cookie。";
      return "国际服 Cookie 未通过官方账号核验，档案未更新。";
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
      if ((suffix && !/^[1-9]\d{0,2}$/u.test(suffix)) || id > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      const user = context.user_id;
      if (user === undefined || !Number.isSafeInteger(user) || user < 1 || context.message_type === "terminal") {
        return "请从对应的 QQ 会话设置国际服。";
      }

      const qq = String(user);
      let saved = false;
      try {
        const current = await profiles.checkinSettings(qq, id);
        if (signal.aborted) return;
        if (!current.loggedIn) return `请先登录档案 ${id}。`;
        await profiles.setProfileCheckinSettings(qq, id, current.revision, sign
          ? { type: "international", enabled: sign[1] === "启用" || sign[1] === "开启" }
          : { type: "international-language", language: locale![2]! });
        saved = true;
        if (signal.aborted) return;
        return await viewProfile(id, context);
      } catch (error) {
        if (signal.aborted) return;
        if (saved) return `档案 ${id} 的国际服设置已保存，暂时无法显示资料卡。`;
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") return `请先登录档案 ${id}。`;
          if (error.code === "changed") return "档案设置已变化，请重试。";
        }
        return "暂时无法保存国际服设置。";
      }
    },
  };
}
