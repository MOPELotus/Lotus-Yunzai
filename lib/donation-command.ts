import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { renderDonationCard } from "@lotus-yunzai/skia/donation";
import { setTimeout as wait } from "node:timers/promises";
import type { CommandModule } from "./commands.ts";
import { segment, type MessageReply } from "./messages.ts";

const url = "https://www.lotusshared.cn/donate";

export function donationCommands(lifetime: AbortSignal, directory = Bun.env.LOTUS_DONATION_RESOURCES?.trim(),
  render: (directory: string, scale: 1 | 2 | 4) => Promise<{ readonly png: Buffer }> = renderDonationCard,
  pause = (signal: AbortSignal) => wait(2_000, undefined, { signal })): CommandModule {
  return {
    name: "@lotus-yunzai/donation",
    commands: {},
    async fallback(_message, context) {
      if (!/^#?(?:捐赠|donate)$/iu.test(context.normalizedMessage)) return;
      const connection = context.groupActivitySignal ?? context.privateCredentialSignal;
      const signal = connection ? AbortSignal.any([lifetime, connection]) : lifetime;
      if (signal.aborted) return [];
      const send = context.reply;
      if (!directory || context.isDelegated) return url;
      const limit = context.inlineImageByteLimit ?? Number.POSITIVE_INFINITY;
      let card: Awaited<ReturnType<typeof render>> | undefined;
      try {
        const scale = nativeImageRasterScale();
        card = await render(directory, scale);
        if (card.png.byteLength > limit && scale === 4 && !signal.aborted) card = await render(directory, 2);
      } catch {
        card = undefined;
      }
      if (signal.aborted) return [];
      const reply = async (message: MessageReply) => {
        try { return await send(message); } catch { return false; }
      };
      if (!card || card.png.byteLength > limit || !await reply(segment.image(card.png))) {
        if (signal.aborted) return [];
        await reply(card ? "捐赠图片发送失败，请通过稍后发送的链接查看。"
          : "捐赠图片生成失败，请通过稍后发送的链接查看。");
      }
      await pause(signal).catch(() => {});
      return signal.aborted ? [] : url;
    },
  };
}
