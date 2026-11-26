import type { MessageEvent } from "./messages.ts";

export function isUncertainDeliveryNotice(message: unknown): boolean {
  return typeof message === "string" &&
    /(?:发送|送达|转发|媒体|视频|语音|音乐文件|二维码)[^\n]{0,45}未确认[，。！!]/u.test(message);
}

export function quietDeliveryNotices(event: MessageEvent): MessageEvent {
  return { ...event, reply: async (...args) => {
    if (isUncertainDeliveryNotice(args[0])) return false;
    return event.reply(...args);
  } };
}
