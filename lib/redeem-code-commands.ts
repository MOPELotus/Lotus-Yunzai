import { formatRedeemResult, parseRedeemCommand, planetLaunchMessages, RedeemCodeService,
  type RedeemPreviewOptions } from "@lotus-yunzai/hoyo-client/redeem-preview";
import { MAX_PROFILE_ID, ProfileError, profileGames, type createProfileStore } from "@lotus-yunzai/account";
import type { CommandContext, CommandModule, CommandReply } from "./commands.ts";
import { isManualRedeemCommand, type createManualRedeemCommand } from "./redeem-code-manual.ts";

const settingPattern = /^#(注册|关闭)自动兑换前瞻(?:兑换码|码|（兑换码）|\(兑换码\))?([1-9]\d{0,2})?$/u;

export function isPreviewRedeemSetting(message: string) {
  return settingPattern.test(message);
}

interface AutoRedeemCommands {
  readonly profiles: Pick<ReturnType<typeof createProfileStore>, "previewRedeemSettings" | "setPreviewRedeemSettings">;
  readonly signal: AbortSignal;
  readonly canRegister: (context: CommandContext) => boolean;
  readonly hasHistory: () => Promise<boolean>;
}

export function redeemCodeCommands(options: RedeemPreviewOptions = {},
  service = new RedeemCodeService(options), automatic?: AutoRedeemCommands,
  manual?: ReturnType<typeof createManualRedeemCommand>): CommandModule {

  async function replyFor(gameId: string): Promise<CommandReply> {
    const result = await service.query(gameId);
    if (result.status !== "available" || !result.codes.length) return formatRedeemResult(result);

    const [title, ...details] = formatRedeemResult({ ...result, codes: [] }).split("\n").filter(Boolean);
    const codes = result.codes.flatMap(({ code, reward }: { code: string; reward: string }) => reward ? [code, reward] : [code]);
    const manualNote = manual && (gameId === "gs" || gameId === "sr")
      ? ["以上为国服前瞻码。另有国际服兑换码时，可在机器人好友私聊发送 " +
        `#${gameId === "sr" ? "星铁" : ""}兑换码使用 <兑换码>。`] : [];
    return { type: "forward", nodes: [title || `${result.gameName}前瞻兑换码`, ...codes, ...details, ...manualNote] };
  }

  async function configure(match: RegExpExecArray, context: CommandContext, auto: AutoRedeemCommands) {
    const id = Number(match[2] ?? 1);
    if (id > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
    if (!context.privateCredentialSignal || context.isDelegated || context.message_type === "terminal" || !context.user_id ||
        !Number.isSafeInteger(context.user_id) || context.user_id < 1) return "请从自己的 QQ 会话修改前瞻兑换设置。";
    const enabled = match[1] === "注册";
    const qq = String(context.user_id);
    const signal = AbortSignal.any([auto.signal, context.privateCredentialSignal]);
    if (signal.aborted) return;
    try {
      const previous = await auto.profiles.previewRedeemSettings(qq, id);
      if (enabled && !previous.loggedIn) return `请先登录档案 ${id}。`;
      if (enabled && !previous.enabled && !auto.canRegister(context)) return "当前会话无权注册前瞻码自动兑换。";
      const update = await auto.profiles.setPreviewRedeemSettings(qq, id, previous.revision, enabled, enabled ? profileGames : undefined, signal);
      if (signal.aborted) return;
      if (!enabled) return `档案 ${id} 已关闭前瞻码自动兑换。`;
      const saved = await auto.profiles.previewRedeemSettings(qq, id);
      if (saved.revision !== update.revision) return "档案设置已变化，请重新查询。";
      if (!saved.allowNewJournal && !await auto.hasHistory().catch(() => false)) {
        return `档案 ${id} 已保存前瞻码设置，补齐旧兑换记录后才会运行。`;
      }
      return `档案 ${id} 已开启原神、星铁、绝区零国服前瞻码自动兑换，结果按签到通知设置发送。`;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ProfileError && (error.code === "missing" || error.code === "login-required")) return `请先登录档案 ${id}。`;
      if (error instanceof ProfileError && error.code === "changed") return "档案设置已变化，请重新发起请求。";
      return "暂时无法保存前瞻码自动兑换设置。";
    }
  }

  return {
    name: "@lotus-yunzai/redeem-codes",
    commands: {},
    fallback(message, context) {
      if (manual && isManualRedeemCommand(context.normalizedMessage)) return manual(context.normalizedMessage, context);
      if (message.trim() === "#星布谷地公测兑换码") {
        const { expired, messages } = planetLaunchMessages((options.now || Date.now)());
        return expired ? messages.join("\n") : { type: "forward", nodes: messages };
      }
      const setting = automatic && settingPattern.exec(message);
      if (automatic && setting) return configure(setting, context, automatic);
      const game = parseRedeemCommand(message);
      if (game) return replyFor(game.id);
    },
  };
}
