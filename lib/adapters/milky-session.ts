import type { BotEvent, MessageReply } from "../messages.ts";
import { createMilkyApi } from "./milky-api.ts";
import type { MilkySettings } from "./milky-config.ts";
import { milkyFriendRequest } from "./milky-friend-request.ts";
import { milkyGroupRequest } from "./milky-group-request.ts";
import { createMilkyGroupReviews } from "./milky-group-reviews.ts";
import { createMilkyFileDelivery } from "./milky-file-delivery.ts";
import { encodeMilkyReply, milkyFriendFileUpload, milkyMessage } from "./milky-message.ts";
import { milkyNotice } from "./milky-notice.ts";

export interface MilkyTransportOptions {
  readonly signal: AbortSignal;
  readonly dispatch: (event: BotEvent) => Promise<void>;
  readonly onSent?: (event: BotEvent, message: unknown) => void;
  readonly masterIds?: (botId: number) => readonly number[];
  readonly isMaster?: (botId: number, userId: number) => boolean;
  readonly groupReviews?: ReturnType<typeof createMilkyGroupReviews>;
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
  const groupReviews = options.groupReviews ?? createMilkyGroupReviews();
  const isMaster = (userId: number) => options.isMaster?.(account, userId) === true;

  const recalls = new Set<ReturnType<typeof setTimeout>>();
  const reviewedFriendRequests = new Set<string>();
  function deliver(event: BotEvent) {
    void dispatch(event).catch(() => console.warn("[Milky] 处理事件失败。"));
  }
  const files = createMilkyFileDelivery(signal, (event) => deliver({ ...event, adapter: "milky" }));
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

    if (body.event_type === "friend_file_upload") {
      const upload = milkyFriendFileUpload(body, account, async (action, params) => {
        return confirmSent(upload, await call(action, params), params.message);
      });
      if (upload) files.upload(upload);
      return "accepted";
    }

    const message = milkyMessage(body, account, async (action, params) => {
      return confirmSent(message, await call(action, params), params.message);
    }, scheduleRecall, async (action, params) => {
      const result = await call.confirmed(action, params);
      if (result.status === "unknown") throw new Error("Milky 转发回执未确认。");
      if (result.status === "confirmed") return confirmSent(message, result.data, params.message);
    });
    if (message && !files.receive(message)) return "accepted";
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

    const friendRequest = body.event_type === "friend_request"
      ? milkyFriendRequest(body, account, approveFriendRequest, (user_id, reply) => sendReply({ user_id }, reply), options.masterIds?.(account) ?? [])
      : undefined;
    let groupRequest;
    if (body.event_type === "group_invitation" || body.event_type === "group_join_request" || body.event_type === "group_invited_join_request") {
      const kind = body.event_type === "group_invitation" ? "invite" : "add";
      const candidate = milkyGroupRequest(body, account, {
        isMaster,
        approve: (flag, accept, reason) => signal.aborted ? Promise.resolve(false)
          : groupReviews.review(account, flag, kind, accept, reason, call.confirmed),
        sendGroup: (group_id, reply) => sendReply({ group_id }, reply),
        sendPrivate: (user_id, reply) => sendReply({ user_id }, reply),
        masterIds: options.masterIds?.(account) ?? [],
      });
      if (candidate) {
        const { decision, ...request } = candidate;
        if (groupReviews.register(request, decision)) groupRequest = request;
      }
    }
    const canReview = message?.isPrivate === true && positiveId(message.user_id) && isMaster(message.user_id);
    const scopedMessage = message && {
      ...message, adapter: "milky" as const, groupRequestScope: "milky" as const, canReviewGroupRequests: canReview,
      reviewGroupRequest: canReview ? (flag: string, kind: "add" | "invite", accept: boolean, reason?: string) =>
        !signal.aborted && positiveId(message.user_id) && isMaster(message.user_id)
          ? groupReviews.review(account, flag, kind, accept, reason, call.confirmed)
          : Promise.resolve(false) : undefined,
    };
    const event = scopedMessage ?? friendRequest ?? groupRequest ?? milkyNotice(body, account, call, sendReply, async (group_id) => {
      const result = await call.confirmed("quit_group", { group_id });
      if (result.status === "unknown") throw new Error("Milky 退群回执未确认。");
      return result.status === "confirmed";
    });
    if (event) deliver(event);
    return "accepted";
  } };
}
