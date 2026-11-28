import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { MAX_PROFILE_ID, ProfileError, type createProfileStore } from "@lotus-yunzai/account";
import { HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { isRedeemCode, openHoYoLabRedemption } from "@lotus-yunzai/hoyo-client/redeem-submit";
import type { CommandContext } from "./commands.ts";
import { createManualRedeemLedger, redeemResultText } from "./redeem-code-runner.ts";

const command = /^([#*%％])(?:(原神|星铁|绝区零))?(兑换码使用|cdk-u)(.*)$/iu;
const target = /^(\S+)(?:[ \t]+档案[ \t]*([1-9]\d{0,2}))?$/u;

export function isManualRedeemCommand(input: string) {
  return command.test(input.trim());
}

export function createManualRedeemCommand(
  profiles: Pick<ReturnType<typeof createProfileStore>, "internationalRedeemContext">,
  ledgerFile: string, signal: AbortSignal, transport: Parameters<typeof openHoYoLabRedemption>[2],
) {
  const ledger = createManualRedeemLedger(ledgerFile);
  return async (message: string, context: CommandContext) => {
    const match = command.exec(message.trim());
    if (!match || context.isDelegated || context.message_type === "terminal") return;
    if (context.message_type !== "private" || !context.privateCredentialSignal ||
        !context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) {
      return $t("lib.redeem-code-manual.text_629260d3d1");
    }
    const active = AbortSignal.any([signal, context.privateCredentialSignal]);
    if (active.aborted) return;
    const game = match[2] === "绝区零" || (!match[2] && (match[1] === "%" || match[1] === "％")) ? "zzz"
      : match[2] === "星铁" || (!match[2] && match[1] === "*") ? "sr" : "gs";
    const label = game === "zzz" ? $t("lib.redeem-code-runner.text_b1110352c9") : game === "sr" ? $t("lib.redeem-code-manual.text_a2927891f0") : $t("lib.redeem-code-manual.text_d1597c51ed");
    const usage = $t("lib.redeem-code-manual.text_e7b4074acc", { "value1": game === "zzz" ? $t("lib.redeem-code-runner.text_b1110352c9") : game === "sr" ? $t("lib.redeem-code-manual.text_a2927891f0") : "" });
    const input = target.exec(match[4]?.trim() ?? "");
    const code = input?.[1];
    if (!code || !isRedeemCode(code)) return usage;
    const id = Number(input[2] ?? 1);
    if (id > MAX_PROFILE_ID) return $t("lib.redeem-code-manual.text_3dd62228d2");
    const qq = String(context.user_id);
    const loginTip = $t("lib.redeem-code-manual.text_71141d994a", { "id": id });
    let claim: Awaited<ReturnType<typeof ledger.claim>>;
    try {
      const source = await profiles.internationalRedeemContext(qq, id, game);
      if (!source || (game !== "gs" && !source.activityCookie)) return loginTip;
      const verifyProfile = async () => {
        active.throwIfAborted();
        const latest = await profiles.internationalRedeemContext(qq, id, game).catch(() => undefined);
        if (latest?.revision !== source.revision) throw new ProfileError("changed", $t("lib.redeem-code-manual.text_8a1edc5158"));
        active.throwIfAborted();
      };
      const client = await openHoYoLabRedemption(source, game, transport, { signal: active, verifyProfile });
      const selected = client.roles.filter(role => role.uid === source.selectedUid);
      const choices = selected.length ? selected : client.roles.length === 1 ? client.roles : client.roles.filter(role => role.chosen);
      if (choices.length !== 1) return $t("lib.redeem-code-manual.text_77081ead52", { "id": id, "label": label });
      const role = choices[0]!;
      const result = await client.submit(code, role, async () => {
        claim = await ledger.claim(source.accountId, game, role, code);
        return Boolean(claim);
      });
      if (result === "duplicate") return $t("lib.redeem-code-manual.text_789ecedc4f");
      if (result === "login-expired") {
        await claim?.release().catch(() => undefined);
        return loginTip;
      }
      await claim?.finish().catch(() => undefined);
      if (!active.aborted) return $t("lib.redeem-code-manual.text_8b852ebfd3", { "label": label, "id": id, "value3": redeemResultText[result] });
    } catch (error) {
      // submit() throws only before the network write. Once it is sent it returns a classified outcome.
      await claim?.release().catch(() => undefined);
      if (active.aborted) return;
      if (error instanceof ProfileError) {
        if (error.code === "missing" || error.code === "login-required") return loginTip;
        if (error.code === "changed") return $t("lib.redeem-code-manual.text_3a686f6291");
      }
      if (error instanceof HoyoRequestError && (error.retcode === -100 || error.status === 401)) return loginTip;
      return $t("lib.redeem-code-manual.text_b85b62bf4a");
    }
  };
}
