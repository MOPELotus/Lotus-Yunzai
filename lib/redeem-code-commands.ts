import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
      ? [$t("lib.redeem-code-commands.text_cea4109f97") +
        $t("lib.redeem-code-commands.text_e237bce40f", { "value1": gameId === "sr" ? $t("lib.redeem-code-commands.text_a2927891f0") : "" })] : [];
    return { type: "forward", nodes: [title || $t("lib.redeem-code-commands.text_a9a43c79eb", { "gameName": result.gameName }), ...codes, ...details, ...manualNote] };
  }

  async function configure(match: RegExpExecArray, context: CommandContext, auto: AutoRedeemCommands) {
    const id = Number(match[2] ?? 1);
    if (id > MAX_PROFILE_ID) return $t("lib.redeem-code-commands.text_3dd62228d2");
    if (!context.privateCredentialSignal || context.isDelegated || context.message_type === "terminal" || !context.user_id ||
        !Number.isSafeInteger(context.user_id) || context.user_id < 1) return $t("lib.redeem-code-commands.text_48d0113bae");
    const enabled = match[1] === "注册";
    const qq = String(context.user_id);
    const signal = AbortSignal.any([auto.signal, context.privateCredentialSignal]);
    if (signal.aborted) return;
    try {
      const previous = await auto.profiles.previewRedeemSettings(qq, id);
      if (enabled && !previous.loggedIn) return $t("lib.redeem-code-commands.text_62b08191fe", { "id": id });
      // Registration also authorizes a missing-history recovery, even when an
      // imported profile already has enable:true. Always check enrollment access.
      if (enabled && !auto.canRegister(context)) return $t("lib.redeem-code-commands.text_933a5a70a9");
      const verifyRegistration = async () => {
        signal.throwIfAborted();
        if (enabled && !auto.canRegister(context)) throw new Error($t("lib.redeem-code-commands.text_d465e88b2a"));
      };
      const update = await auto.profiles.setPreviewRedeemSettings(qq, id, previous.revision, enabled,
        enabled ? profileGames : undefined, signal, verifyRegistration, enabled ? { enroll: true } : undefined);
      if (signal.aborted) return;
      if (!enabled) return $t("lib.redeem-code-commands.text_27f809d59d", { "id": id });
      const saved = await auto.profiles.previewRedeemSettings(qq, id);
      if (saved.revision !== update.revision) return $t("lib.redeem-code-commands.text_8ddd81a278");
      if (!saved.allowNewJournal && !await auto.hasHistory().catch(() => false)) {
        return $t("lib.redeem-code-commands.text_eb1aeb8f05", { "id": id });
      }
      return $t("lib.redeem-code-commands.text_f82376cf45", { "id": id });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ProfileError && (error.code === "missing" || error.code === "login-required")) return $t("lib.redeem-code-commands.text_62b08191fe", { "id": id });
      if (error instanceof ProfileError && error.code === "changed") return $t("lib.redeem-code-commands.text_57818c07b1");
      return $t("lib.redeem-code-commands.text_16ff7c4e9c");
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
