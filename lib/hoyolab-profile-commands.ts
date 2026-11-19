import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import type { CommandContext, CommandModule, CommandReply } from "./commands.ts";

const cookieInput = /^\s*[#＃井/]\s*绑定\s*(?:国际服|海外服)\s*cookie/iu;
const toggle = /^#(启用|开启|关闭|禁用)(?:国际服|海外服)(?:签到)?([0-9]*)$/u;
const language = /^#设置(?:国际服|海外服)语言([0-9]*)\s+([A-Za-z_-]{1,32})$/u;

export function isHoYoLabCookieInput(raw: string): boolean {
  return cookieInput.test(raw);
}

export function hoyoLabProfileCommands(directory: string | undefined, signal: AbortSignal, {
  viewProfile,
}: {
  readonly viewProfile: (profileId: number, context: CommandContext) => CommandReply | Promise<CommandReply>;
}): CommandModule {
  const profiles = createProfileStore(directory);
  return {
    name: "@lotus-yunzai/hoyolab-profile",
    commands: {},
    async fallback(_message, context) {
      if (signal.aborted) return;
      const message = context.normalizedMessage;
      if (isHoYoLabCookieInput(message) || isHoYoLabCookieInput(context.raw_message ?? "")) {
        return context.message_type === "private"
          ? "当前无法核验国际服 Cookie 的账号归属。"
          : "请在私聊中绑定国际服 Cookie。";
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
        if (!current.loggedIn) return `请先登录 profile ${id}。`;
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
          if (error.code === "missing" || error.code === "login-required") return `请先登录 profile ${id}。`;
          if (error.code === "changed") return "档案设置已变化，请重试。";
        }
        return "暂时无法保存国际服设置。";
      }
    },
  };
}
