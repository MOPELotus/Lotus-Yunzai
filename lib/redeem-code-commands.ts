import { formatRedeemResult, parseRedeemCommand, RedeemCodeService, type RedeemPreviewOptions } from "@lotus-yunzai/hoyo-client/redeem-preview";
import type { CommandModule, CommandReply } from "./commands.ts";

export function redeemCodeCommands(options: RedeemPreviewOptions = {}): CommandModule {
  const service = new RedeemCodeService(options);

  async function replyFor(gameId: string): Promise<CommandReply> {
    const result = await service.query(gameId);
    if (result.status !== "available" || !result.codes.length) return formatRedeemResult(result);

    const [title, ...details] = formatRedeemResult({ ...result, codes: [] }).split("\n").filter(Boolean);
    const codes = result.codes.flatMap(({ code, reward }: { code: string; reward: string }) => reward ? [code, reward] : [code]);
    return { type: "forward", nodes: [title || "原神前瞻兑换码", ...codes, ...details] };
  }

  return {
    name: "@lotus-yunzai/redeem-codes",
    commands: {},
    fallback(message) {
      const game = parseRedeemCommand(message);
      if (game) return replyFor(game.id);
    },
  };
}
