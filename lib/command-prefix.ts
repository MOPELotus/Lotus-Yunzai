import type { MessageEvent } from "./messages.ts";

const starRail = /^#?(?:\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/u;
const zenless = /^#?(?:%|％|绝区零|绝区)+/u;

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
