import type { MessageEvent, ReplyOptions } from "./messages.ts";

export const groupPersonalRecallSeconds = 120;

/** Keep account replies on the original group connection and withdraw bot replies. */
export function withGroupPersonalReplies(event: MessageEvent, current: () => boolean): MessageEvent {
  if (event.message_type !== "group") return event;
  const options = (value?: ReplyOptions): ReplyOptions => ({
    ...value,
    recallMsg: typeof value?.recallMsg === "number" && value.recallMsg > 0
      ? Math.min(value.recallMsg, groupPersonalRecallSeconds) : groupPersonalRecallSeconds,
    recallOriginal: false,
  });
  return {
    ...event,
    reply(message, quote, value) {
      return current() ? event.reply(message, quote, options(value)) : Promise.resolve(false);
    },
    ...(event.forward ? { forward: (nodes, name, value) => current()
      ? event.forward!(nodes, name, options(value)) : Promise.resolve(false) } : {}),
  };
}
