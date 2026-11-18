import type { BotEvent } from "../messages.ts";
import { createMilkyApi } from "./milky-api.ts";
import type { MilkySettings } from "./milky-config.ts";
import { encodeMilkyReply, milkyMessage } from "./milky-message.ts";
import { milkyNotice } from "./milky-notice.ts";

export interface MilkyTransportOptions {
  readonly signal: AbortSignal;
  readonly dispatch: (event: BotEvent) => Promise<void>;
  readonly onSent?: (event: BotEvent, message: unknown) => void;
}

export interface MilkySession {
  receive(value: unknown): "accepted" | "invalid" | "foreign" | "offline";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasMessageSequence(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function openMilkySession(settings: MilkySettings, options: MilkyTransportOptions): Promise<MilkySession | undefined> {
  const { signal, dispatch, onSent } = options;
  const call = createMilkyApi(settings, signal);
  const login = await call("get_login_info", {});
  const account = login?.uin;
  if (signal.aborted || !positiveId(account)) return;

  const recalls = new Set<ReturnType<typeof setTimeout>>();
  signal.addEventListener("abort", () => {
    for (const timer of recalls) clearTimeout(timer);
    recalls.clear();
  }, { once: true });

  function scheduleRecall(action: string, params: Record<string, unknown>, seconds: number) {
    if (signal.aborted) return;
    const timer = setTimeout(async () => {
      recalls.delete(timer);
      if (!await call(action, params) && !signal.aborted) console.warn("[Milky] 消息撤回未获确认。");
    }, seconds * 1_000);
    timer.unref();
    recalls.add(timer);
  }

  return { receive(body) {
    if (signal.aborted) return "offline";
    if (!record(body) || !positiveId(body.self_id) || typeof body.event_type !== "string" ||
        !body.event_type || !record(body.data)) return "invalid";
    if (body.self_id !== account) return "foreign";
    if (body.event_type === "bot_offline") return "offline";

    function confirmSent(event: BotEvent | undefined, result: Record<string, unknown> | undefined, content: unknown) {
      if (event && hasMessageSequence(result?.message_seq)) {
        onSent?.(event, content);
      }
      return result;
    }

    const message = milkyMessage(body, account, async (action, params) => {
      return confirmSent(message, await call(action, params), params.message);
    }, scheduleRecall, async (action, params) => {
      const result = await call.confirmed(action, params);
      if (result.status === "unknown") throw new Error("Milky 转发回执未确认。");
      if (result.status === "confirmed") return confirmSent(message, result.data, params.message);
    });
    const notice = message ? undefined : milkyNotice(body, account, call, async (target, reply) => {
      const content = encodeMilkyReply(reply);
      if (!content) return false;
      const action = "group_id" in target ? "send_group_message" : "send_private_message";
      const result = await call.confirmed(action, { ...target, message: content });
      if (result.status === "rejected") return false;
      if (result.status === "unknown" || !hasMessageSequence(result.data.message_seq)) {
        throw new Error("Milky 通知回复未确认。");
      }
      confirmSent(notice, result.data, content);
      return true;
    });
    const event = message ?? notice;
    if (event) void dispatch(event).catch(() => console.warn("[Milky] 处理事件失败。"));
    return "accepted";
  } };
}
