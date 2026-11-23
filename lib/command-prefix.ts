import type { MessageEvent } from "./messages.ts";

// The standalone plugin also used sr. Limit its Latin suffixes to commands and panel names.
const starRail = /^(?:[#*]?sr(?=\p{Script=Han}|(?:help|(?:API|api)列表)$|[A-Za-z0-9_-]{1,32}面板)|#?(?:\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+)/u;
const zenless = /^#?(?:%|％|绝区零|绝区)+/u;
const originalPicture = /^(#(?:原神|星铁|绝区零)?|[*%％])?(?:获取|给我|我要|求|发|发下|发个|发一下)?原图(?:吧|呗)?$/u;

export function normalizeOriginalPictureCommand(message: string): string {
  return message.replace(originalPicture, "$1原图");
}

export function normalizeGameCommand(event: MessageEvent): MessageEvent {
  const { msg } = event;
  const game = starRail.test(msg) ? "sr" : zenless.test(msg) ? "zzz" : event.game;
  const command = game === "sr" ? msg.replace(starRail, "#星铁")
    : game === "zzz" ? msg.replace(zenless, "#绝区零") : msg;
  return {
    ...event,
    msg: command,
    game,
    get isSr() { return this.game === "sr"; },
    set isSr(enabled) { this.game = enabled ? "sr" : "gs"; },
    get isGs() { return this.game === "gs"; },
    set isGs(enabled) { this.game = enabled ? "gs" : "sr"; },
  };
}
