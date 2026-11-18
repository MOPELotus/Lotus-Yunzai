import type { BotEvent, MessageReply } from "../messages.ts";
import { createMilkyApi } from "./milky-api.ts";
import type { MilkySettings } from "./milky-config.ts";
import { milkyFriendRequest } from "./milky-friend-request.ts";
import { encodeMilkyReply, milkyMessage } from "./milky-message.ts";
import { milkyNotice } from "./milky-notice.ts";

export interface MilkyTransportOptions {
  readonly signal: AbortSignal;
  readonly dispatch: (event: BotEvent) => Promise<void>;
  readonly onSent?: (event: BotEvent, message: unknown) => void;
  readonly masterIds?: (botId: number) => readonly number[];
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
  const reviewedFriendRequests = new Set<string>();
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

  async function approveFriendRequest(flag: string, action: string, params: Record<string, unknown>) {
    if (signal.aborted || reviewedFriendRequests.has(flag)) return false;
    reviewedFriendRequests.add(flag);
    if (reviewedFriendRequests.size > 4096) reviewedFriendRequests.delete(reviewedFriendRequests.values().next().value!);
    const result = await call.confirmed(action, params);
    if (result.status === "unknown") throw new Error("Milky 好友审批结果未确认。");
    return result.status === "confirmed";
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
    async function sendReply(target: { group_id: number } | { user_id: number }, reply: MessageReply) {
      const content = encodeMilkyReply(reply);
      if (!content) return false;
      const action = "group_id" in target ? "send_group_message" : "send_private_message";
      const result = await call.confirmed(action, { ...target, message: content });
      if (result.status === "rejected") return false;
      if (result.status === "unknown" || !hasMessageSequence(result.data.message_seq)) {
        throw new Error("Milky 通知回复未确认。");
      }
      confirmSent(event && { ...event, ...target }, result.data, content);
      return true;
    }

    const request = body.event_type === "friend_request"
      ? milkyFriendRequest(body, account, approveFriendRequest, (user_id, reply) => sendReply({ user_id }, reply), options.masterIds?.(account) ?? [])
      : undefined;
    const event = message ?? request ?? milkyNotice(body, account, call, sendReply);
    if (event) void dispatch(event).catch(() => console.warn("[Milky] 处理事件失败。"));
    return "accepted";
  } };
}
