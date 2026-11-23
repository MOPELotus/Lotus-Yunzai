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
      return "请在机器人好友私聊中使用兑换码。";
    }
    const active = AbortSignal.any([signal, context.privateCredentialSignal]);
    if (active.aborted) return;
    const game = match[2] === "绝区零" || (!match[2] && (match[1] === "%" || match[1] === "％")) ? "zzz"
      : match[2] === "星铁" || (!match[2] && match[1] === "*") ? "sr" : "gs";
    if (game === "zzz") return "绝区零请在游戏内兑换。";
    const label = game === "sr" ? "星铁" : "原神";
    const usage = `请发送 #${game === "sr" ? "星铁" : ""}兑换码使用 <兑换码>，可在末尾加 档案2 指定档案。`;
    const input = target.exec(match[4]?.trim() ?? "");
    const code = input?.[1];
    if (!code || !isRedeemCode(code)) return usage;
    const id = Number(input[2] ?? 1);
    if (id > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
    const qq = String(context.user_id);
    const loginTip = `请在档案 ${id} 重新绑定已核验的 HoYoLAB Cookie。`;
    let claim: Awaited<ReturnType<typeof ledger.claim>>;
    try {
      const source = await profiles.internationalRedeemContext(qq, id, game);
      if (!source || (game === "sr" && !source.activityCookie)) return loginTip;
      const verifyProfile = async () => {
        active.throwIfAborted();
        const latest = await profiles.internationalRedeemContext(qq, id, game).catch(() => undefined);
        if (latest?.revision !== source.revision) throw new ProfileError("changed", "档案已变更。");
        active.throwIfAborted();
      };
      const client = await openHoYoLabRedemption(source, game, transport, { signal: active, verifyProfile });
      const selected = client.roles.filter(role => role.uid === source.selectedUid);
      const choices = selected.length ? selected : client.roles.length === 1 ? client.roles : client.roles.filter(role => role.chosen);
      if (choices.length !== 1) return `档案 ${id} 无法唯一确定${label}国际服角色，请在 HoYoLAB 选择默认角色后再试。`;
      const role = choices[0]!;
      const result = await client.submit(code, role, async () => {
        claim = await ledger.claim(source.accountId, game, role, code);
        return Boolean(claim);
      });
      if (result === "duplicate") return "此角色已提交过这条兑换码，请到游戏内检查。";
      if (result === "login-expired") {
        await claim?.release().catch(() => undefined);
        return loginTip;
      }
      await claim?.finish().catch(() => undefined);
      if (!active.aborted) return `${label}国际服兑换 · 档案 ${id}\n${redeemResultText[result]}`;
    } catch (error) {
      // submit() throws only before the network write. Once it is sent it returns a classified outcome.
      await claim?.release().catch(() => undefined);
      if (active.aborted) return;
      if (error instanceof ProfileError) {
        if (error.code === "missing" || error.code === "login-required") return loginTip;
        if (error.code === "changed") return "档案已变更，请重新发起兑换。";
      }
      if (error instanceof HoyoRequestError && (error.retcode === -100 || error.status === 401)) return loginTip;
      return "暂时无法核对兑换档案，本次未提交。";
    }
  };
}
